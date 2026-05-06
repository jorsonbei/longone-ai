#!/usr/bin/env python3
"""
HFCD Trading V1.39 Gold Forward Paper Shadow.

V1.38 froze a roll-aware paper execution baseline. This stage does not tune
signals, Q exits, trailing, sizing, or thresholds. It only starts a forward
shadow ledger:

1. Load the frozen V1.38 production config.
2. Check whether today's frozen signal set has an actionable gold signal.
3. Probe current/recent GC BBO availability when Databento is configured.
4. Append paper-only cycle, quote, route, order, and PnL audit rows.

The script is safe to run repeatedly. Each run appends a new shadow cycle.
"""

from __future__ import annotations

import csv
import json
import math
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_39_GoldForwardPaperShadow"
ROOT = Path.cwd()
V38_DIR = ROOT / "outputs" / "hfcd_trading_v1_38_gold_roll_aware_paper_baseline"
V29_DIR = ROOT / "outputs" / "hfcd_trading_v1_29_gold_official_settlement_baseline_replay"
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_39_gold_forward_paper_shadow"

V38_CONFIG = V38_DIR / "hfcd_trading_v1_38_production_config.json"
V38_SUMMARY = V38_DIR / "hfcd_trading_v1_38_summary.json"
V38_TRADE_LEDGER = V38_DIR / "hfcd_trading_v1_38_trade_ledger.csv"
V38_PAPER_ORDERS = V38_DIR / "hfcd_trading_v1_38_paper_orders.csv"
V29_SELECTED_TRADES = V29_DIR / "hfcd_trading_v1_29_selected_trades.csv"

SHADOW_CYCLES = OUT_DIR / "hfcd_trading_v1_39_shadow_cycles.csv"
QUOTE_AVAILABILITY = OUT_DIR / "hfcd_trading_v1_39_quote_availability.csv"
SHADOW_ORDERS = OUT_DIR / "hfcd_trading_v1_39_shadow_orders.csv"
ROUTE_LEDGER = OUT_DIR / "hfcd_trading_v1_39_roll_route_usage.csv"
STATE_JSON = OUT_DIR / "hfcd_trading_v1_39_shadow_state.json"
SUMMARY_JSON = OUT_DIR / "hfcd_trading_v1_39_summary.json"
SUMMARY_CSV = OUT_DIR / "hfcd_trading_v1_39_summary.csv"
REPORT_MD = OUT_DIR / "HFCD_Trading_V1_39_GoldForwardPaperShadow.md"
REPORT_PNG = OUT_DIR / "HFCD_Trading_V1_39_GoldForwardPaperShadow.png"

DATASET = "GLBX.MDP3"
DEFAULT_PROBE_MINUTES = 15
QUOTE_MAX_SPREAD_ABS = float(os.environ.get("HFCD_V139_QUOTE_MAX_SPREAD_ABS", "2.0"))
QUOTE_MIN_TOP_BOOK_SIZE = float(os.environ.get("HFCD_V139_QUOTE_MIN_TOP_BOOK_SIZE", "1.0"))


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def env_shadow_date() -> str:
    override = os.environ.get("HFCD_V139_SHADOW_DATE", "").strip()
    if override:
        return str(pd.Timestamp(override).date())
    return str(pd.Timestamp(utc_now()).date())


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def clean_json(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): clean_json(v) for k, v in value.items()}
    if isinstance(value, list):
        return [clean_json(v) for v in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        v = float(value)
        return v if math.isfinite(v) else None
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, datetime):
        return value.isoformat()
    try:
        if pd.isna(value) and not isinstance(value, (str, bytes, bool, type(None))):
            return None
    except TypeError:
        pass
    return value


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.write_text(json.dumps(clean_json(data), ensure_ascii=False, indent=2), encoding="utf-8")


def append_rows(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fields: list[str] = []
    if path.exists() and path.stat().st_size > 0:
        with path.open("r", newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            try:
                fields = next(reader)
            except StopIteration:
                fields = []
    for row in rows:
        for key in row.keys():
            if key not in fields:
                fields.append(key)
    existing_rows: list[dict[str, Any]] = []
    if path.exists() and path.stat().st_size > 0:
        with path.open("r", newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            existing_rows = list(reader)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in existing_rows:
            writer.writerow({field: row.get(field, "") for field in fields})
        for row in rows:
            writer.writerow({field: clean_json(row.get(field, "")) for field in fields})


def read_csv_or_empty(path: Path) -> pd.DataFrame:
    if not path.exists() or path.stat().st_size == 0:
        return pd.DataFrame()
    return pd.read_csv(path)


def max_drawdown(values: list[float]) -> float:
    if not values:
        return 0.0
    equity = np.cumsum(values)
    peak = np.maximum.accumulate(equity)
    return float((equity - peak).min())


def profit_factor(values: list[float]) -> float:
    wins = sum(v for v in values if v > 0)
    losses = abs(sum(v for v in values if v < 0))
    if losses == 0:
        return 999.0 if wins > 0 else 0.0
    return float(wins / losses)


def load_required_inputs() -> tuple[dict[str, Any], dict[str, Any], pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    for path in [V38_CONFIG, V38_SUMMARY, V38_TRADE_LEDGER, V38_PAPER_ORDERS, V29_SELECTED_TRADES]:
        if not path.exists():
            raise FileNotFoundError(path)
    config = json.loads(V38_CONFIG.read_text(encoding="utf-8"))
    summary = json.loads(V38_SUMMARY.read_text(encoding="utf-8"))
    if not summary.get("production_gate", {}).get("passed"):
        raise RuntimeError("V1.38 production gate has not passed; V1.39 cannot start shadow mode.")
    trades = pd.read_csv(V38_TRADE_LEDGER)
    orders = pd.read_csv(V38_PAPER_ORDERS)
    signals = pd.read_csv(V29_SELECTED_TRADES)
    for col in ["date", "exit_date"]:
        if col in signals.columns:
            signals[col] = pd.to_datetime(signals[col], errors="coerce").dt.date.astype(str)
    return config, summary, trades, orders, signals


def active_gc_symbols(asof_date: str) -> list[str]:
    """Return a small front/next GC route set using COMEX active months."""
    asof = pd.Timestamp(asof_date)
    active_months = [(2, "G"), (4, "J"), (6, "M"), (8, "Q"), (10, "V"), (12, "Z")]
    year = int(asof.year)
    candidates: list[tuple[int, int, str]] = []
    for y in [year, year + 1]:
        for month, code in active_months:
            expiry_anchor = pd.Timestamp(year=y, month=month, day=1)
            if expiry_anchor >= asof.replace(day=1):
                candidates.append((y, month, f"GC{code}{str(y)[-1]}"))
    candidates.sort(key=lambda item: (item[0], item[1]))
    return [item[2] for item in candidates[:3]]


def route_rank(symbol: str, route_set: list[str]) -> int:
    try:
        return route_set.index(symbol)
    except ValueError:
        return 999


def normalize_price(value: Any) -> float | None:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v) or v <= 0:
        return None
    return v


def extract_latest_quote(raw: pd.DataFrame, symbol: str, schema: str, source: str) -> dict[str, Any]:
    if raw is None or raw.empty:
        return {
            "symbol": symbol,
            "schema": schema,
            "quote_status": "no_rows",
            "source": source,
        }
    df = raw.reset_index().copy()
    ts_col = next((c for c in ["ts_recv", "ts_event", "timestamp", "time"] if c in df.columns), None)
    bid_col = next((c for c in ["bid_px_00", "bid_px", "bid"] if c in df.columns), None)
    ask_col = next((c for c in ["ask_px_00", "ask_px", "ask"] if c in df.columns), None)
    bid_sz_col = next((c for c in ["bid_sz_00", "bid_size", "bid_sz"] if c in df.columns), None)
    ask_sz_col = next((c for c in ["ask_sz_00", "ask_size", "ask_sz"] if c in df.columns), None)
    if ts_col is None or bid_col is None or ask_col is None:
        return {
            "symbol": symbol,
            "schema": schema,
            "quote_status": "missing_bid_ask_columns",
            "raw_columns": ",".join(map(str, df.columns[:32])),
            "source": source,
        }
    df["timestamp"] = pd.to_datetime(df[ts_col], errors="coerce", utc=True)
    df["bid"] = pd.to_numeric(df[bid_col], errors="coerce")
    df["ask"] = pd.to_numeric(df[ask_col], errors="coerce")
    if bid_sz_col:
        df["bid_size"] = pd.to_numeric(df[bid_sz_col], errors="coerce")
    else:
        df["bid_size"] = np.nan
    if ask_sz_col:
        df["ask_size"] = pd.to_numeric(df[ask_sz_col], errors="coerce")
    else:
        df["ask_size"] = np.nan
    df = df.dropna(subset=["timestamp", "bid", "ask"]).copy()
    df = df[(df["bid"] > 0) & (df["ask"] >= df["bid"])].copy()
    if df.empty:
        return {
            "symbol": symbol,
            "schema": schema,
            "quote_status": "no_clean_numeric_bid_ask",
            "source": source,
        }
    last = df.sort_values("timestamp").iloc[-1]
    bid = float(last["bid"])
    ask = float(last["ask"])
    spread = ask - bid
    top_book = float(np.nanmin([last.get("bid_size", np.nan), last.get("ask_size", np.nan)]))
    if not math.isfinite(top_book):
        top_book = 0.0
    executable = spread <= QUOTE_MAX_SPREAD_ABS and top_book >= QUOTE_MIN_TOP_BOOK_SIZE
    return {
        "symbol": symbol,
        "schema": schema,
        "quote_status": "executable_clean_quote" if executable else "quote_not_executable_by_gate",
        "timestamp_utc": pd.Timestamp(last["timestamp"]).isoformat(),
        "bid": bid,
        "ask": ask,
        "mid": (bid + ask) / 2.0,
        "spread": spread,
        "top_book_size": top_book,
        "rows": int(len(df)),
        "source": source,
    }


def parse_databento_safe_end(message: str) -> datetime | None:
    patterns = [
        r"available up to '([^']+)'",
        r"end time before ([0-9T:\-\.]+Z)",
    ]
    for pattern in patterns:
        match = re.search(pattern, message)
        if not match:
            continue
        ts = pd.Timestamp(match.group(1)).to_pydatetime()
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return ts - timedelta(seconds=1)
    return None


def databento_get_range_with_fallback(
    client: Any,
    symbol: str,
    schema: str,
    start: datetime,
    end: datetime,
    probe_minutes: int,
) -> tuple[Any, datetime, datetime, str]:
    current_start = start
    current_end = end
    last_error: Exception | None = None
    fallback_note = "requested_window"
    for _ in range(4):
        try:
            data = client.timeseries.get_range(
                dataset=DATASET,
                schema=schema,
                symbols=[symbol],
                stype_in="raw_symbol",
                start=current_start.isoformat(),
                end=current_end.isoformat(),
            )
            return data, current_start, current_end, fallback_note
        except Exception as exc:
            last_error = exc
            safe_end = parse_databento_safe_end(str(exc))
            if safe_end is None:
                break
            if safe_end >= current_end:
                safe_end = current_end - timedelta(minutes=1)
            current_end = safe_end
            current_start = current_end - timedelta(minutes=probe_minutes)
            fallback_note = "databento_available_range_fallback"
    if last_error is not None:
        raise last_error
    raise RuntimeError("databento_get_range_failed_without_exception")


def probe_databento_quotes(symbols: list[str], now: datetime) -> tuple[list[dict[str, Any]], str]:
    if os.environ.get("HFCD_V139_ENABLE_DATABENTO_PROBE", "1") != "1":
        return (
            [
                {
                    "symbol": symbol,
                    "schema": "bbo-1s",
                    "quote_status": "probe_disabled",
                    "source": "env:HFCD_V139_ENABLE_DATABENTO_PROBE=0",
                }
                for symbol in symbols
            ],
            "probe_disabled",
        )

    load_env_file(ROOT / ".env.local")
    load_env_file(ROOT / ".dev.vars")
    key = os.environ.get("DATABENTO_API_KEY")
    if not key:
        return (
            [
                {
                    "symbol": symbol,
                    "schema": "bbo-1s",
                    "quote_status": "missing_databento_api_key",
                    "source": "env",
                }
                for symbol in symbols
            ],
            "missing_key",
        )

    try:
        import databento as db  # type: ignore
    except Exception as exc:
        return (
            [
                {
                    "symbol": symbol,
                    "schema": "bbo-1s",
                    "quote_status": "databento_import_failed",
                    "error": str(exc),
                    "source": "python_import",
                }
                for symbol in symbols
            ],
            "package_missing",
        )

    probe_minutes = int(os.environ.get("HFCD_V139_PROBE_MINUTES", str(DEFAULT_PROBE_MINUTES)))
    end = now
    start = now - timedelta(minutes=probe_minutes)
    client = db.Historical(key=key)
    rows: list[dict[str, Any]] = []
    for symbol in symbols:
        symbol_rows: list[dict[str, Any]] = []
        for schema in ["bbo-1s", "mbp-1"]:
            try:
                data, used_start, used_end, fallback_note = databento_get_range_with_fallback(
                    client=client,
                    symbol=symbol,
                    schema=schema,
                    start=start,
                    end=end,
                    probe_minutes=probe_minutes,
                )
                raw = data.to_df()
                quote = extract_latest_quote(raw, symbol, schema, f"databento:{DATASET}:{schema}")
                quote["probe_window_start_utc"] = used_start.isoformat()
                quote["probe_window_end_utc"] = used_end.isoformat()
                quote["probe_window_note"] = fallback_note
                if quote.get("quote_status") == "no_rows":
                    # Databento's latest authorized endpoint can land inside the
                    # Globex daily maintenance break. If so, look back to the
                    # prior trading window before declaring quote unavailable.
                    prior_end = used_end - timedelta(minutes=90)
                    prior_start = prior_end - timedelta(minutes=probe_minutes)
                    try:
                        prior_data = client.timeseries.get_range(
                            dataset=DATASET,
                            schema=schema,
                            symbols=[symbol],
                            stype_in="raw_symbol",
                            start=prior_start.isoformat(),
                            end=prior_end.isoformat(),
                        )
                        prior_quote = extract_latest_quote(
                            prior_data.to_df(),
                            symbol,
                            schema,
                            f"databento:{DATASET}:{schema}",
                        )
                        if prior_quote.get("quote_status") != "no_rows":
                            quote = prior_quote
                            quote["probe_window_start_utc"] = prior_start.isoformat()
                            quote["probe_window_end_utc"] = prior_end.isoformat()
                            quote["probe_window_note"] = f"{fallback_note}|prior_trading_window_retry"
                    except Exception as prior_exc:
                        quote["prior_trading_window_error"] = str(prior_exc)[:300]
                symbol_rows.append(quote)
                if quote.get("quote_status") == "executable_clean_quote":
                    break
            except Exception as exc:
                symbol_rows.append(
                    {
                        "symbol": symbol,
                        "schema": schema,
                        "quote_status": "probe_error",
                        "error": str(exc)[:500],
                        "source": f"databento:{DATASET}:{schema}",
                        "probe_window_start_utc": start.isoformat(),
                        "probe_window_end_utc": end.isoformat(),
                    }
                )
        rows.extend(symbol_rows[-1:] if symbol_rows else [])

    if any(row.get("quote_status") == "executable_clean_quote" for row in rows):
        return rows, "quote_available"
    if any(row.get("quote_status") == "probe_error" for row in rows):
        return rows, "probe_error"
    return rows, "quote_unavailable"


@dataclass
class ShadowState:
    open_positions: list[dict[str, Any]]
    cumulative_realized_pnl_usd: float
    total_shadow_orders: int
    total_shadow_cycles: int


def load_state() -> ShadowState:
    if not STATE_JSON.exists():
        return ShadowState(open_positions=[], cumulative_realized_pnl_usd=0.0, total_shadow_orders=0, total_shadow_cycles=0)
    data = json.loads(STATE_JSON.read_text(encoding="utf-8"))
    return ShadowState(
        open_positions=list(data.get("open_positions", [])),
        cumulative_realized_pnl_usd=float(data.get("cumulative_realized_pnl_usd", 0.0)),
        total_shadow_orders=int(data.get("total_shadow_orders", 0)),
        total_shadow_cycles=int(data.get("total_shadow_cycles", 0)),
    )


def save_state(state: ShadowState) -> None:
    write_json(
        STATE_JSON,
        {
            "version": VERSION,
            "updated_at": utc_now().isoformat(),
            "open_positions": state.open_positions,
            "cumulative_realized_pnl_usd": state.cumulative_realized_pnl_usd,
            "total_shadow_orders": state.total_shadow_orders,
            "total_shadow_cycles": state.total_shadow_cycles,
        },
    )


def latest_frozen_signal(signals: pd.DataFrame) -> dict[str, Any]:
    if signals.empty:
        return {"latest_signal_date": None, "latest_exit_date": None, "latest_signal_score": None}
    sub = signals.copy()
    if "variant" in sub.columns:
        sub = sub[sub["variant"].astype(str).str.contains("official_v1_20_base", na=False)].copy()
    if "official_coverage" in sub.columns:
        sub = sub[sub["official_coverage"].astype(str) == "matched"].copy()
    sub["date_ts"] = pd.to_datetime(sub["date"], errors="coerce")
    sub = sub.dropna(subset=["date_ts"]).sort_values(["date_ts", "score"])
    if sub.empty:
        return {"latest_signal_date": None, "latest_exit_date": None, "latest_signal_score": None}
    row = sub.iloc[-1]
    return {
        "latest_signal_date": str(row.get("date")),
        "latest_exit_date": str(row.get("exit_date")),
        "latest_signal_score": float(row.get("score", 0.0)),
        "latest_front_symbol": row.get("front_symbol"),
        "latest_exit_symbol": row.get("exit_symbol"),
    }


def current_signals(signals: pd.DataFrame, shadow_date: str) -> pd.DataFrame:
    if signals.empty:
        return pd.DataFrame()
    sub = signals.copy()
    if "variant" in sub.columns:
        sub = sub[sub["variant"].astype(str).str.contains("official_v1_20_base", na=False)].copy()
    if "official_coverage" in sub.columns:
        sub = sub[sub["official_coverage"].astype(str) == "matched"].copy()
    sub = sub[sub["date"].astype(str) == shadow_date].copy()
    if "promotable" in sub.columns:
        sub = sub[sub["promotable"].astype(str).str.lower().isin(["true", "1", "yes"])].copy()
    return sub.sort_values("score", ascending=False)


def quote_map(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    best: dict[str, dict[str, Any]] = {}
    for row in rows:
        sym = str(row.get("symbol", ""))
        if not sym:
            continue
        cur = best.get(sym)
        if cur is None or row.get("quote_status") == "executable_clean_quote":
            best[sym] = row
    return best


def executable_quote_for(symbol: str, route_set: list[str], quotes: dict[str, dict[str, Any]]) -> tuple[dict[str, Any] | None, str]:
    candidates = [symbol] + [s for s in route_set if s != symbol]
    for candidate in candidates:
        q = quotes.get(candidate)
        if q and q.get("quote_status") == "executable_clean_quote":
            route = "original" if candidate == symbol else "roll_aware_adjacent_contract"
            return q, route
    return None, "quote_unavailable"


def order_signature(row: pd.Series) -> str:
    return f"{row.get('date')}::{row.get('exit_date')}::{row.get('front_symbol')}::{float(row.get('score', 0.0)):.6f}"


def process_shadow_orders(
    run_id: str,
    now_iso: str,
    shadow_date: str,
    signals_today: pd.DataFrame,
    route_set: list[str],
    quotes: dict[str, dict[str, Any]],
    config: dict[str, Any],
    state: ShadowState,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], str, float]:
    orders: list[dict[str, Any]] = []
    route_rows: list[dict[str, Any]] = []
    new_open: list[dict[str, Any]] = []
    realized_pnl = 0.0

    # First try closing positions whose frozen exit date has arrived.
    remaining_positions: list[dict[str, Any]] = []
    for pos in state.open_positions:
        if str(pos.get("exit_date")) > shadow_date:
            remaining_positions.append(pos)
            continue
        q, route = executable_quote_for(str(pos.get("exit_symbol")), route_set, quotes)
        if q is None:
            remaining_positions.append(pos)
            orders.append(
                {
                    "run_id": run_id,
                    "timestamp_utc": now_iso,
                    "order_id": f"v1_39_close_pending_{pos.get('position_id')}",
                    "order_stage": "close_pending",
                    "paper_status": "quote_unavailable_keep_open",
                    "signal_date": pos.get("signal_date"),
                    "exit_date": pos.get("exit_date"),
                    "selected_symbol": pos.get("exit_symbol"),
                    "pnl_usd": 0.0,
                    "production_mode": "paper_only_no_real_order",
                }
            )
            continue
        fill = float(q["bid"])
        entry_fill = float(pos["entry_fill_price"])
        qty = float(pos["quantity_oz_proxy"])
        fee = float(pos.get("fee_usd_roundtrip", 0.0))
        pnl = (fill - entry_fill) * qty - fee
        realized_pnl += pnl
        orders.append(
            {
                "run_id": run_id,
                "timestamp_utc": now_iso,
                "order_id": f"v1_39_close_{pos.get('position_id')}",
                "order_stage": "close",
                "paper_status": "paper_closed",
                "signal_date": pos.get("signal_date"),
                "exit_date": pos.get("exit_date"),
                "original_symbol": pos.get("exit_symbol"),
                "selected_symbol": q.get("symbol"),
                "route": route,
                "route_rank": route_rank(str(q.get("symbol")), route_set),
                "fill_side": "sell_at_bid",
                "fill_price": fill,
                "mid_price": q.get("mid"),
                "spread_usd": q.get("spread"),
                "top_book_size": q.get("top_book_size"),
                "quantity_oz_proxy": qty,
                "notional_usd": pos.get("notional_usd"),
                "pnl_usd": pnl,
                "production_mode": "paper_only_no_real_order",
            }
        )
        route_rows.append(
            {
                "run_id": run_id,
                "timestamp_utc": now_iso,
                "leg": "close",
                "original_symbol": pos.get("exit_symbol"),
                "selected_symbol": q.get("symbol"),
                "route": route,
                "roll_repair_used": route != "original",
                "paper_status": "paper_closed",
            }
        )

    state.open_positions = remaining_positions

    existing_signatures = {str(pos.get("signal_signature")) for pos in state.open_positions}
    opened_any = False
    for _, row in signals_today.iterrows():
        sig = order_signature(row)
        if sig in existing_signatures:
            continue
        front = str(row.get("front_symbol"))
        q, route = executable_quote_for(front, route_set, quotes)
        if q is None:
            orders.append(
                {
                    "run_id": run_id,
                    "timestamp_utc": now_iso,
                    "order_id": f"v1_39_open_skipped_{sig}",
                    "order_stage": "open",
                    "paper_status": "quote_unavailable_no_open",
                    "signal_date": row.get("date"),
                    "exit_date": row.get("exit_date"),
                    "original_symbol": front,
                    "selected_symbol": "",
                    "signal_score": row.get("score"),
                    "notional_usd": row.get("notional_usd", config.get("notional", {}).get("per_trade_notional_usd", 10_000.0)),
                    "pnl_usd": 0.0,
                    "production_mode": "paper_only_no_real_order",
                }
            )
            continue
        fill = float(q["ask"])
        notional = float(row.get("notional_usd", config.get("notional", {}).get("per_trade_notional_usd", 10_000.0)))
        qty = notional / fill if fill > 0 else 0.0
        position_id = f"{shadow_date}_{front}_{len(state.open_positions) + len(new_open)}"
        pos = {
            "position_id": position_id,
            "signal_signature": sig,
            "signal_date": row.get("date"),
            "exit_date": row.get("exit_date"),
            "front_symbol": front,
            "exit_symbol": row.get("exit_symbol", front),
            "entry_selected_symbol": q.get("symbol"),
            "entry_route": route,
            "entry_fill_price": fill,
            "quantity_oz_proxy": qty,
            "notional_usd": notional,
            "fee_usd_roundtrip": config.get("notional", {}).get("roundtrip_fee_usd", 3.5),
            "signal_score": float(row.get("score", 0.0)),
            "opened_at_utc": now_iso,
        }
        new_open.append(pos)
        opened_any = True
        orders.append(
            {
                "run_id": run_id,
                "timestamp_utc": now_iso,
                "order_id": f"v1_39_open_{position_id}",
                "order_stage": "open",
                "paper_status": "paper_opened",
                "signal_date": row.get("date"),
                "exit_date": row.get("exit_date"),
                "original_symbol": front,
                "selected_symbol": q.get("symbol"),
                "route": route,
                "route_rank": route_rank(str(q.get("symbol")), route_set),
                "fill_side": "buy_at_ask",
                "fill_price": fill,
                "mid_price": q.get("mid"),
                "spread_usd": q.get("spread"),
                "top_book_size": q.get("top_book_size"),
                "quantity_oz_proxy": qty,
                "notional_usd": notional,
                "signal_score": row.get("score"),
                "pnl_usd": 0.0,
                "production_mode": "paper_only_no_real_order",
            }
        )
        route_rows.append(
            {
                "run_id": run_id,
                "timestamp_utc": now_iso,
                "leg": "open",
                "original_symbol": front,
                "selected_symbol": q.get("symbol"),
                "route": route,
                "roll_repair_used": route != "original",
                "paper_status": "paper_opened",
            }
        )

    state.open_positions.extend(new_open)

    if not orders:
        orders.append(
            {
                "run_id": run_id,
                "timestamp_utc": now_iso,
                "order_id": f"v1_39_no_trade_{run_id}",
                "order_stage": "no_trade",
                "paper_status": "wait_no_frozen_signal",
                "signal_date": shadow_date,
                "pnl_usd": 0.0,
                "production_mode": "paper_only_no_real_order",
            }
        )

    if opened_any:
        decision = "paper_opened_from_frozen_signal"
    elif realized_pnl != 0:
        decision = "paper_closed_due_frozen_exit_date"
    elif len(signals_today) > 0:
        decision = "frozen_signal_seen_but_quote_unavailable"
    else:
        decision = "wait_no_frozen_signal"
    return orders, route_rows, state.open_positions, decision, realized_pnl


def build_summary(
    config: dict[str, Any],
    v38_summary: dict[str, Any],
    shadow_date: str,
    run_id: str,
    signal_info: dict[str, Any],
    signals_today: pd.DataFrame,
    quote_rows: list[dict[str, Any]],
    quote_probe_status: str,
    decision: str,
    cycle_row: dict[str, Any],
) -> dict[str, Any]:
    orders = read_csv_or_empty(SHADOW_ORDERS)
    cycles = read_csv_or_empty(SHADOW_CYCLES)
    quotes = read_csv_or_empty(QUOTE_AVAILABILITY)
    route = read_csv_or_empty(ROUTE_LEDGER)

    order_pnls = pd.to_numeric(orders.get("pnl_usd", pd.Series(dtype=float)), errors="coerce").fillna(0.0).tolist()
    realized = [v for v in order_pnls if abs(v) > 0]
    executable_quote_count = int((quotes.get("quote_status", pd.Series(dtype=str)).astype(str) == "executable_clean_quote").sum()) if not quotes.empty else 0
    route_roll_count = int(route.get("roll_repair_used", pd.Series(dtype=str)).astype(str).str.lower().isin(["true", "1"]).sum()) if not route.empty else 0
    latest_signal_date = signal_info.get("latest_signal_date")
    signal_age_days = None
    if latest_signal_date:
        signal_age_days = int((pd.Timestamp(shadow_date) - pd.Timestamp(latest_signal_date)).days)

    status = "gold_forward_paper_shadow_initialized"
    if decision.startswith("paper_opened"):
        status = "gold_forward_paper_shadow_paper_position_opened"
    elif decision.startswith("paper_closed"):
        status = "gold_forward_paper_shadow_paper_position_closed"

    return {
        "version": VERSION,
        "generated_at": utc_now().isoformat(),
        "status": status,
        "mode": "forward_shadow_paper_only_no_real_order",
        "frozen_config": {
            "source_version": config.get("version"),
            "decision": v38_summary.get("decision"),
            "q_or_trailing_tuning": False,
            "position_sizing_tuning": False,
            "frozen_rules": config.get("frozen_rules", {}),
        },
        "current_cycle": {
            "run_id": run_id,
            "shadow_date": shadow_date,
            "decision": decision,
            "signals_today": int(len(signals_today)),
            "quote_probe_status": quote_probe_status,
            "quote_symbols_checked": [row.get("symbol") for row in quote_rows],
            "cycle_realized_pnl_usd": cycle_row.get("cycle_realized_pnl_usd", 0.0),
        },
        "signal_feed": {
            **signal_info,
            "shadow_date": shadow_date,
            "signal_age_days": signal_age_days,
            "signal_status": "current_frozen_signal_available" if len(signals_today) else "no_current_frozen_signal",
        },
        "shadow_ledger": {
            "cycles": int(len(cycles)),
            "order_rows": int(len(orders)),
            "realized_order_count": int(len(realized)),
            "open_position_count": int(cycle_row.get("open_position_count", 0)),
            "realized_pnl_usd": float(sum(realized)),
            "profit_factor": profit_factor(realized),
            "max_drawdown_usd": max_drawdown(realized),
            "executable_quote_rows": executable_quote_count,
            "roll_route_usage_count": route_roll_count,
        },
        "v38_reference": {
            "net_pnl_usd": v38_summary.get("paper_metrics", {}).get("net_pnl_usd"),
            "profit_factor": v38_summary.get("paper_metrics", {}).get("profit_factor"),
            "stress_net_pnl_usd": v38_summary.get("stress_reference", {}).get("net_pnl_usd"),
            "production_gate_passed": v38_summary.get("production_gate", {}).get("passed"),
        },
        "decision": "keep_running_forward_shadow_without_tuning",
        "next_step": "Schedule this runner daily/intraday and accumulate forward quote availability, roll route usage, and paper PnL before any Q/trailing parameter changes.",
    }


def write_summary_csv(summary: dict[str, Any]) -> None:
    row = {
        "version": summary["version"],
        "status": summary["status"],
        "shadow_date": summary["current_cycle"]["shadow_date"],
        "current_decision": summary["current_cycle"]["decision"],
        "signals_today": summary["current_cycle"]["signals_today"],
        "quote_probe_status": summary["current_cycle"]["quote_probe_status"],
        "cycles": summary["shadow_ledger"]["cycles"],
        "order_rows": summary["shadow_ledger"]["order_rows"],
        "open_position_count": summary["shadow_ledger"]["open_position_count"],
        "realized_pnl_usd": summary["shadow_ledger"]["realized_pnl_usd"],
        "profit_factor": summary["shadow_ledger"]["profit_factor"],
        "latest_signal_date": summary["signal_feed"].get("latest_signal_date"),
        "signal_age_days": summary["signal_feed"].get("signal_age_days"),
    }
    pd.DataFrame([row]).to_csv(SUMMARY_CSV, index=False)


def write_report(summary: dict[str, Any]) -> None:
    ledger = summary["shadow_ledger"]
    cycle = summary["current_cycle"]
    signal = summary["signal_feed"]
    report = f"""# {VERSION}

## 结论

V1.39 已启动 V1.38 冻结配置的 forward paper shadow。此阶段只记录前向影子盘，不调信号、不调 Q、不调 trailing、不调仓位。

- 当前状态：`{summary["status"]}`
- 本轮日期：`{cycle["shadow_date"]}`
- 本轮决策：`{cycle["decision"]}`
- 今日冻结信号数：`{cycle["signals_today"]}`
- 报价探针状态：`{cycle["quote_probe_status"]}`
- 当前未平 paper 持仓：`{ledger["open_position_count"]}`
- 累计已实现 paper PnL：`${ledger["realized_pnl_usd"]:.2f}`

## 冻结配置

- 来源：`{summary["frozen_config"]["source_version"]}`
- V1.38 决策：`{summary["frozen_config"]["decision"]}`
- 允许：paper trading、forward shadow logs、execution cost monitoring
- 禁止：真实下单、Q/trailing 调参、仓位调参、脏报价填补

## 信号状态

- 最新本地冻结信号日：`{signal.get("latest_signal_date")}`
- 最新本地退出日：`{signal.get("latest_exit_date")}`
- 距本轮日期天数：`{signal.get("signal_age_days")}`
- 当前信号状态：`{signal.get("signal_status")}`

如果本轮没有冻结信号，系统必须保持等待，不允许为了提高交易频率而临时放宽门槛。

## 影子盘账本

- 累计周期数：{ledger["cycles"]}
- 累计订单/审计行：{ledger["order_rows"]}
- 已实现订单数：{ledger["realized_order_count"]}
- 可执行报价行：{ledger["executable_quote_rows"]}
- roll 路由使用次数：{ledger["roll_route_usage_count"]}
- 累计 PF：{ledger["profit_factor"]:.3f}
- 累计最大回撤：`${ledger["max_drawdown_usd"]:.2f}`

## 下一步

继续定时运行 V1.39，积累实时 quote availability、roll route usage、paper PnL。只有前向账本足够后，才讨论 Q/trailing 或信号层改动。
"""
    REPORT_MD.write_text(report, encoding="utf-8")


def write_plot(summary: dict[str, Any]) -> None:
    cycles = read_csv_or_empty(SHADOW_CYCLES)
    orders = read_csv_or_empty(SHADOW_ORDERS)
    quotes = read_csv_or_empty(QUOTE_AVAILABILITY)
    routes = read_csv_or_empty(ROUTE_LEDGER)

    fig, axes = plt.subplots(2, 2, figsize=(14, 8))
    fig.suptitle("HFCD Trading V1.39 Gold Forward Paper Shadow", fontsize=15, fontweight="bold")

    ax = axes[0, 0]
    labels = ["cycles", "orders", "open pos", "exec quotes"]
    vals = [
        len(cycles),
        len(orders),
        summary["shadow_ledger"]["open_position_count"],
        summary["shadow_ledger"]["executable_quote_rows"],
    ]
    ax.bar(labels, vals, color=["#2f6f5e", "#4f9d7e", "#c6a15b", "#6d8fd3"])
    ax.set_title("Shadow ledger counts")
    ax.grid(axis="y", alpha=0.25)

    ax = axes[0, 1]
    if not orders.empty:
        pnl = pd.to_numeric(orders.get("pnl_usd"), errors="coerce").fillna(0.0)
        ax.plot(np.cumsum(pnl), color="#2f6f5e", linewidth=2)
    else:
        ax.plot([0], [0], color="#2f6f5e", linewidth=2)
    ax.axhline(0, color="#666", linewidth=1)
    ax.set_title("Cumulative paper PnL")
    ax.grid(alpha=0.25)

    ax = axes[1, 0]
    if not quotes.empty and "quote_status" in quotes.columns:
        q_counts = quotes["quote_status"].astype(str).value_counts()
        ax.bar(q_counts.index, q_counts.values, color="#5b7c99")
        ax.tick_params(axis="x", labelrotation=25)
    else:
        ax.bar(["no_quote_rows"], [0], color="#5b7c99")
    ax.set_title("Quote availability status")
    ax.grid(axis="y", alpha=0.25)

    ax = axes[1, 1]
    if not routes.empty and "route" in routes.columns:
        r_counts = routes["route"].astype(str).value_counts()
        ax.bar(r_counts.index, r_counts.values, color="#8c6c4c")
    else:
        ax.bar(["no_route_usage"], [0], color="#8c6c4c")
    ax.set_title("Roll route usage")
    ax.grid(axis="y", alpha=0.25)

    fig.tight_layout(rect=[0, 0.02, 1, 0.95])
    fig.savefig(REPORT_PNG, dpi=160)
    plt.close(fig)


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    config, v38_summary, _trades, _orders, signals = load_required_inputs()

    now = utc_now()
    now_iso = now.isoformat()
    run_id = now.strftime("%Y%m%dT%H%M%SZ")
    shadow_date = env_shadow_date()
    state = load_state()

    signal_info = latest_frozen_signal(signals)
    signals_today = current_signals(signals, shadow_date)
    route_set = active_gc_symbols(shadow_date)
    required_symbols = set(route_set)
    for _, row in signals_today.iterrows():
        required_symbols.add(str(row.get("front_symbol")))
        required_symbols.add(str(row.get("exit_symbol")))
    for pos in state.open_positions:
        required_symbols.add(str(pos.get("front_symbol")))
        required_symbols.add(str(pos.get("exit_symbol")))
    required_symbols = {s for s in required_symbols if s and s != "nan"}

    quote_rows, quote_probe_status = probe_databento_quotes(sorted(required_symbols), now)
    for row in quote_rows:
        row["run_id"] = run_id
        row["shadow_date"] = shadow_date
        row["recorded_at_utc"] = now_iso
    append_rows(QUOTE_AVAILABILITY, quote_rows)

    orders, routes, _positions, decision, cycle_pnl = process_shadow_orders(
        run_id=run_id,
        now_iso=now_iso,
        shadow_date=shadow_date,
        signals_today=signals_today,
        route_set=route_set,
        quotes=quote_map(quote_rows),
        config=config,
        state=state,
    )
    append_rows(SHADOW_ORDERS, orders)
    append_rows(ROUTE_LEDGER, routes)

    state.cumulative_realized_pnl_usd += float(cycle_pnl)
    state.total_shadow_orders += int(len([o for o in orders if str(o.get("paper_status", "")).startswith("paper_")]))
    state.total_shadow_cycles += 1
    save_state(state)

    cycle_row = {
        "run_id": run_id,
        "timestamp_utc": now_iso,
        "shadow_date": shadow_date,
        "source_config": config.get("version"),
        "decision": decision,
        "signals_today": int(len(signals_today)),
        "latest_signal_date": signal_info.get("latest_signal_date"),
        "latest_exit_date": signal_info.get("latest_exit_date"),
        "quote_probe_status": quote_probe_status,
        "quote_symbols_checked": ",".join(sorted(required_symbols)),
        "open_position_count": int(len(state.open_positions)),
        "cycle_realized_pnl_usd": float(cycle_pnl),
        "cumulative_realized_pnl_usd": float(state.cumulative_realized_pnl_usd),
        "production_mode": "paper_only_no_real_order",
        "strategy_tuning": "none",
    }
    append_rows(SHADOW_CYCLES, [cycle_row])

    summary = build_summary(
        config=config,
        v38_summary=v38_summary,
        shadow_date=shadow_date,
        run_id=run_id,
        signal_info=signal_info,
        signals_today=signals_today,
        quote_rows=quote_rows,
        quote_probe_status=quote_probe_status,
        decision=decision,
        cycle_row=cycle_row,
    )
    write_json(SUMMARY_JSON, summary)
    write_summary_csv(summary)
    write_report(summary)
    write_plot(summary)

    print(
        json.dumps(
            {
                "version": VERSION,
                "status": summary["status"],
                "shadow_date": shadow_date,
                "decision": decision,
                "signals_today": int(len(signals_today)),
                "quote_probe_status": quote_probe_status,
                "open_positions": len(state.open_positions),
                "cycle_realized_pnl_usd": float(cycle_pnl),
                "out_dir": str(OUT_DIR),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
