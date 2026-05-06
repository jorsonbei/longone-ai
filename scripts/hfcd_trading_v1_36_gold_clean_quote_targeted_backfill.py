#!/usr/bin/env python3
"""
HFCD Trading V1.36 Gold Clean Quote Targeted Backfill.

V1.35 improved clean BBO/MBP coverage from 60.34% to 74.14%, but still missed
the 80% gate. V1.36 does not change signals, anchors, Q exits, trailing exits,
or quote-quality thresholds. It only targets the remaining V1.35 unclean legs
and tries to backfill a later clean executable quote from the same or adjacent
GC contracts.

This is still a cost-layer coverage repair. Long-wait fills are audited
separately so they cannot be confused with strategy improvement.
"""

from __future__ import annotations

import csv
import importlib.util
import json
import math
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_36_GoldCleanQuoteTargetedBackfill"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_36_gold_clean_quote_targeted_backfill"
CACHE_DIR = OUT_DIR / "cache_targeted_bbo_mbp"
V35_SCRIPT = ROOT / "scripts" / "hfcd_trading_v1_35_gold_clean_quote_coverage_repair.py"
V35_OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_35_gold_clean_quote_coverage_repair"

FETCH_BBO = os.environ.get("HFCD_V136_FETCH_BBO", "1") == "1"
MAX_FETCH_LEGS = int(os.environ.get("HFCD_V136_MAX_FETCH_LEGS", "220"))
LOOKBACK_MINUTES = int(os.environ.get("HFCD_V136_LOOKBACK_MINUTES", "5"))
LOOKAHEAD_MINUTES = int(os.environ.get("HFCD_V136_LOOKAHEAD_MINUTES", "1440"))
QUOTE_MAX_WAIT_SECONDS = int(os.environ.get("HFCD_V136_QUOTE_MAX_WAIT_SECONDS", str(24 * 3600)))
ALT_CONTRACT_STEPS = int(os.environ.get("HFCD_V136_ALT_CONTRACT_STEPS", "4"))
ALT_MAX_PRICE_DIST_USD = float(os.environ.get("HFCD_V136_ALT_MAX_PRICE_DIST_USD", "25.0"))
ALT_MAX_PRICE_DIST_BPS = float(os.environ.get("HFCD_V136_ALT_MAX_PRICE_DIST_BPS", "100.0"))
PRODUCTION_MAX_WAIT_SECONDS = int(os.environ.get("HFCD_V136_PRODUCTION_MAX_WAIT_SECONDS", "3600"))


def import_module(path: Path, name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


v35 = import_module(V35_SCRIPT, "hfcd_v35_clean_quote")
v34 = v35.v34
v33 = v35.v33

v34.FETCH_BBO = FETCH_BBO
v34.MAX_FETCH_LEGS = MAX_FETCH_LEGS
v34.LOOKBACK_MINUTES = LOOKBACK_MINUTES
v34.LOOKAHEAD_MINUTES = LOOKAHEAD_MINUTES
v34.QUOTE_MAX_WAIT_SECONDS = QUOTE_MAX_WAIT_SECONDS

MONTH_CODES = ["G", "J", "M", "Q", "V", "Z"]


def clean_json(value: Any) -> Any:
    return v34.clean_json(value)


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fields: list[str] = []
    for row in rows:
        for key in row:
            if key not in fields:
                fields.append(key)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def parse_gc_symbol(symbol: str) -> tuple[int, int] | None:
    match = re.fullmatch(r"GC([FGHJKMNQUVXZ])(\d)", str(symbol).strip().upper())
    if not match:
        return None
    month_code, year_digit = match.groups()
    return 2020 + int(year_digit), MONTH_CODES.index(month_code)


def symbol_from_cycle(year: int, month_idx: int) -> str:
    while month_idx < 0:
        year -= 1
        month_idx += len(MONTH_CODES)
    while month_idx >= len(MONTH_CODES):
        year += 1
        month_idx -= len(MONTH_CODES)
    return f"GC{MONTH_CODES[month_idx]}{year % 10}"


def adjacent_contracts(symbol: str) -> list[tuple[str, str, int]]:
    parsed = parse_gc_symbol(symbol)
    if parsed is None:
        return [(str(symbol), "original", 0)]
    year, month_idx = parsed
    offsets: list[int] = [0]
    for step in range(1, ALT_CONTRACT_STEPS + 1):
        offsets.extend([step, -step])
    seen: set[str] = set()
    out: list[tuple[str, str, int]] = []
    for offset in offsets:
        candidate = symbol_from_cycle(year, month_idx + offset)
        if candidate in seen:
            continue
        seen.add(candidate)
        out.append((candidate, "original" if offset == 0 else f"adjacent_{offset:+d}", abs(offset)))
    return out


def price_distance(candidate: dict[str, Any], anchor_price: float) -> tuple[float, float]:
    mid = float(candidate.get("mid", math.nan))
    if not math.isfinite(mid) or not math.isfinite(anchor_price) or anchor_price <= 0:
        return math.inf, math.inf
    dist = abs(mid - anchor_price)
    return dist, 10_000.0 * dist / anchor_price


def accept_candidate(candidate: dict[str, Any], original_symbol: str, anchor_price: float) -> bool:
    if candidate.get("status") != "matched":
        return False
    if candidate.get("selected_symbol") == original_symbol:
        return True
    dist, bps = price_distance(candidate, anchor_price)
    return dist <= ALT_MAX_PRICE_DIST_USD and bps <= ALT_MAX_PRICE_DIST_BPS


def repair_stage(seconds: float) -> str:
    if not math.isfinite(seconds):
        return "missing"
    if seconds <= 600:
        return "first_clean_after_anchor_10m"
    if seconds <= 1800:
        return "first_clean_after_anchor_30m"
    if seconds <= 3600:
        return "first_clean_after_anchor_60m"
    if seconds <= 6 * 3600:
        return "targeted_clean_after_anchor_6h"
    if seconds <= 24 * 3600:
        return "targeted_clean_after_anchor_24h"
    return "outside_targeted_window"


def quote_quality_mask(book: pd.DataFrame) -> pd.Series:
    return v34.quote_quality_mask(book)


def select_first_clean_quote(book: pd.DataFrame, target: pd.Timestamp) -> dict[str, Any]:
    if book.empty:
        return {"status": "missing_bbo_mbp", "seconds_away": math.nan, "repair_stage": "missing"}
    after = book[(book["timestamp"] >= target) & (book["timestamp"] <= target + pd.Timedelta(seconds=QUOTE_MAX_WAIT_SECONDS))].copy()
    if after.empty:
        return {"status": "no_quote_after_anchor", "seconds_away": math.nan, "repair_stage": "missing"}

    quality = after[quote_quality_mask(after)].copy()
    if quality.empty:
        first_bad = after.sort_values("timestamp").iloc[0]
        seconds = float((first_bad["timestamp"] - target).total_seconds())
        return {
            "status": "quote_quality_fail_after_anchor",
            "timestamp": first_bad["timestamp"],
            "seconds_away": seconds,
            "repair_stage": "dirty_observable_only",
            "bid": float(first_bad["bid_px_00"]),
            "ask": float(first_bad["ask_px_00"]),
            "mid": float(first_bad["mid_price"]),
            "spread": float(first_bad["spread"]),
            "top_book_size": float(first_bad["top_book_size"]),
            "quality_fail_count": int(len(after)),
            "max_spread_in_window": float(pd.to_numeric(after["spread"], errors="coerce").max()),
            "min_spread_in_window": float(pd.to_numeric(after["spread"], errors="coerce").min()),
        }

    first = quality.sort_values("timestamp").iloc[0]
    seconds = float((first["timestamp"] - target).total_seconds())
    return {
        "status": "matched",
        "timestamp": first["timestamp"],
        "seconds_away": seconds,
        "repair_stage": repair_stage(seconds),
        "bid": float(first["bid_px_00"]),
        "ask": float(first["ask_px_00"]),
        "mid": float(first["mid_price"]),
        "spread": float(first["spread"]),
        "top_book_size": float(first["top_book_size"]),
        "bid_size": float(first["bid_sz_00"]) if not pd.isna(first["bid_sz_00"]) else 0.0,
        "ask_size": float(first["ask_sz_00"]) if not pd.isna(first["ask_sz_00"]) else 0.0,
        "quality_fail_count": int(len(after) - len(quality)),
        "max_spread_in_window": float(pd.to_numeric(after["spread"], errors="coerce").max()),
        "min_spread_in_window": float(pd.to_numeric(after["spread"], errors="coerce").min()),
    }


class TargetedBookStore:
    def __init__(self) -> None:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        self.client = v34.get_databento_client()
        self.fetch_count = 0
        self.loaded: dict[tuple[str, str], pd.DataFrame] = {}
        self.fetch_log: list[dict[str, Any]] = []

    def local_candidates(self, symbol: str, date_key: str) -> list[Path]:
        patterns = [
            f"outputs/**/bbo_1s_{symbol}_{date_key}.csv",
            f"outputs/**/bbo_1s_{symbol}_{date_key}_*.csv",
            f"outputs/**/mbp_1_{symbol}_{date_key}.csv",
            f"outputs/**/mbp_1_{symbol}_{date_key}_*.csv",
            f"outputs/**/bbo_1s_{symbol}_{date_key}*_targeted*.csv",
            f"outputs/**/mbp_1_{symbol}_{date_key}*_targeted*.csv",
        ]
        found: list[Path] = []
        for pattern in patterns:
            found.extend(ROOT.glob(pattern))
        return sorted({p for p in found if p.exists() and p.stat().st_size > 0})

    def cache_file(self, schema: str, symbol: str, target: pd.Timestamp) -> Path:
        stamp = target.strftime("%Y-%m-%d_%H%M")
        return CACHE_DIR / f"{schema.replace('-', '_')}_{symbol}_{stamp}_targeted_{LOOKAHEAD_MINUTES}m.csv"

    def get_window(self, symbol: str, target: pd.Timestamp) -> tuple[pd.DataFrame, str]:
        key = (symbol, target.strftime("%Y-%m-%d_%H%M"))
        if key in self.loaded:
            return self.loaded[key], "memory"

        date_key = target.date().isoformat()
        start = target - pd.Timedelta(minutes=LOOKBACK_MINUTES)
        end = target + pd.Timedelta(minutes=LOOKAHEAD_MINUTES)
        frames: list[pd.DataFrame] = []
        sources: list[str] = []

        for path in self.local_candidates(symbol, date_key):
            try:
                raw = pd.read_csv(path)
            except Exception:
                continue
            norm = v33.normalize_book(raw, symbol=symbol)
            if norm.empty:
                continue
            part = norm[(norm["timestamp"] >= start) & (norm["timestamp"] <= end)].copy()
            if not part.empty:
                frames.append(part)
                sources.append(f"local:{path}")

        if self.client is not None and self.fetch_count < MAX_FETCH_LEGS:
            for schema in v34.FETCH_SCHEMA_ORDER:
                cache = self.cache_file(schema, symbol, target)
                raw = pd.DataFrame()
                status = "not_requested"
                error = ""
                if cache.exists() and cache.stat().st_size > 0:
                    try:
                        raw = pd.read_csv(cache)
                        status = "cache"
                    except Exception as exc:
                        status = f"cache_invalid:{type(exc).__name__}"
                        error = str(exc)[:500]
                else:
                    try:
                        raw = v34.fetch_range_to_df(self.client, schema=schema, symbol=symbol, start=start, end=end)
                        raw.to_csv(cache, index=False)
                        status = "downloaded"
                        self.fetch_count += 1
                    except Exception as exc:
                        status = f"failed:{type(exc).__name__}"
                        error = str(exc)[:500]
                        self.fetch_count += 1

                norm = v33.normalize_book(raw, symbol=symbol)
                self.fetch_log.append(
                    {
                        "symbol": symbol,
                        "target": target.isoformat(),
                        "schema": schema,
                        "start": start.isoformat(),
                        "end": end.isoformat(),
                        "status": status,
                        "normalized_rows": int(len(norm)),
                        "error": error,
                    }
                )
                if not norm.empty:
                    part = norm[(norm["timestamp"] >= start) & (norm["timestamp"] <= end)].copy()
                    if not part.empty:
                        frames.append(part)
                        sources.append(f"{schema}:{status}:{cache}")
                        break

        if not frames:
            out = pd.DataFrame()
            self.loaded[key] = out
            return out, "missing_bbo_mbp"

        out = pd.concat(frames, ignore_index=True)
        out = out.sort_values("timestamp").drop_duplicates("timestamp").reset_index(drop=True)
        self.loaded[key] = out
        return out, " | ".join(sources)


def candidate_quote(store: TargetedBookStore, original_symbol: str, target: pd.Timestamp, anchor_price: float) -> dict[str, Any]:
    attempts: list[dict[str, Any]] = []
    for symbol, route, rank in adjacent_contracts(original_symbol):
        book, source = store.get_window(symbol, target)
        result = dict(select_first_clean_quote(book, target))
        result["selected_symbol"] = symbol
        result["route"] = route
        result["route_rank"] = rank
        result["source"] = source
        dist, bps = price_distance(result, anchor_price)
        result["anchor_price_distance_usd"] = dist
        result["anchor_price_distance_bps"] = bps
        result["accepted"] = accept_candidate(result, original_symbol, anchor_price)
        attempts.append(result)

    accepted = [row for row in attempts if row["accepted"]]
    if accepted:
        accepted.sort(
            key=lambda row: (
                int(row.get("route_rank", 999)),
                float(row.get("seconds_away", math.inf)) if math.isfinite(float(row.get("seconds_away", math.inf))) else math.inf,
                float(row.get("anchor_price_distance_usd", math.inf)),
            )
        )
        best = dict(accepted[0])
        best["all_attempts"] = attempts
        return best

    original = [row for row in attempts if row.get("selected_symbol") == original_symbol]
    best_fail = dict(original[0] if original else (attempts[0] if attempts else {}))
    best_fail["all_attempts"] = attempts
    return best_fail


def side_from_existing(row: pd.Series, side: str) -> dict[str, Any]:
    prefix = f"{side}_"
    selected = row.get(f"{prefix}selected_symbol", row.get("front_symbol" if side == "entry" else "exit_symbol"))
    return {
        "status": row.get(f"{prefix}bbo_status"),
        "timestamp": row.get(f"{prefix}bbo_ts"),
        "seconds_away": row.get(f"{prefix}seconds_away"),
        "repair_stage": row.get(f"{prefix}repair_stage"),
        "source": row.get(f"{prefix}bbo_source"),
        "selected_symbol": selected,
        "route": row.get(f"{prefix}route"),
        "route_rank": row.get(f"{prefix}route_rank"),
        "bid": row.get(f"{prefix}bid"),
        "ask": row.get(f"{prefix}ask"),
        "mid": row.get(f"{prefix}mid"),
        "spread": row.get(f"{prefix}spread"),
        "top_book_size": row.get(f"{prefix}top_book_size"),
        "quality_fail_count": row.get(f"{prefix}quality_fail_count"),
        "anchor_price_distance_usd": row.get(f"{prefix}anchor_price_distance_usd"),
        "anchor_price_distance_bps": row.get(f"{prefix}anchor_price_distance_bps"),
        "max_spread_in_window": row.get(f"{prefix}max_spread_in_window"),
        "min_spread_in_window": row.get(f"{prefix}min_spread_in_window"),
        "accepted": row.get(f"{prefix}bbo_status") == "matched",
    }


def recompute_trade(row: pd.Series, entry: dict[str, Any], exit_: dict[str, Any]) -> dict[str, Any]:
    matched = entry.get("status") == "matched" and exit_.get("status") == "matched" and entry.get("accepted") and exit_.get("accepted")
    notional = float(row["notional_usd"])
    fee = float(row["fee_usd"])
    side = str(row.get("side", "long")).lower()
    bbo_return = math.nan
    bbo_pnl = math.nan
    bbo_2x = math.nan
    bbo_mid_pnl = math.nan
    if matched:
        if side.startswith("short"):
            bbo_return = (float(entry["bid"]) - float(exit_["ask"])) / float(entry["bid"])
            mid_return = (float(entry["mid"]) - float(exit_["mid"])) / float(entry["mid"])
        else:
            bbo_return = (float(exit_["bid"]) - float(entry["ask"])) / float(entry["ask"])
            mid_return = (float(exit_["mid"]) - float(entry["mid"])) / float(entry["mid"])
        bbo_pnl = notional * bbo_return - fee
        bbo_2x = notional * bbo_return - 2.0 * fee
        bbo_mid_pnl = notional * mid_return - fee

    out = dict(row.to_dict())
    out.update(
        {
            "entry_selected_symbol": entry.get("selected_symbol"),
            "exit_selected_symbol": exit_.get("selected_symbol"),
            "entry_route": entry.get("route"),
            "exit_route": exit_.get("route"),
            "entry_route_rank": entry.get("route_rank"),
            "exit_route_rank": exit_.get("route_rank"),
            "entry_bbo_status": entry.get("status"),
            "exit_bbo_status": exit_.get("status"),
            "entry_repair_stage": entry.get("repair_stage"),
            "exit_repair_stage": exit_.get("repair_stage"),
            "entry_bbo_source": entry.get("source"),
            "exit_bbo_source": exit_.get("source"),
            "entry_bbo_ts": entry.get("timestamp"),
            "exit_bbo_ts": exit_.get("timestamp"),
            "entry_seconds_away": entry.get("seconds_away"),
            "exit_seconds_away": exit_.get("seconds_away"),
            "entry_bid": entry.get("bid"),
            "entry_ask": entry.get("ask"),
            "entry_mid": entry.get("mid"),
            "entry_spread": entry.get("spread"),
            "entry_top_book_size": entry.get("top_book_size"),
            "entry_quality_fail_count": entry.get("quality_fail_count"),
            "entry_anchor_price_distance_usd": entry.get("anchor_price_distance_usd"),
            "entry_anchor_price_distance_bps": entry.get("anchor_price_distance_bps"),
            "entry_max_spread_in_window": entry.get("max_spread_in_window"),
            "entry_min_spread_in_window": entry.get("min_spread_in_window"),
            "exit_bid": exit_.get("bid"),
            "exit_ask": exit_.get("ask"),
            "exit_mid": exit_.get("mid"),
            "exit_spread": exit_.get("spread"),
            "exit_top_book_size": exit_.get("top_book_size"),
            "exit_quality_fail_count": exit_.get("quality_fail_count"),
            "exit_anchor_price_distance_usd": exit_.get("anchor_price_distance_usd"),
            "exit_anchor_price_distance_bps": exit_.get("anchor_price_distance_bps"),
            "exit_max_spread_in_window": exit_.get("max_spread_in_window"),
            "exit_min_spread_in_window": exit_.get("min_spread_in_window"),
            "bbo_mbp_matched": bool(matched),
            "bbo_bidask_return": bbo_return,
            "bbo_bidask_pnl_usd": bbo_pnl,
            "bbo_bidask_pnl_2x_fee_usd": bbo_2x,
            "bbo_mid_pnl_usd": bbo_mid_pnl,
            "bbo_spread_cost_usd": bbo_mid_pnl - bbo_pnl if matched else math.nan,
            "pnl_delta_bbo_vs_anchor_usd": bbo_pnl - float(row["anchor_pnl"]) if matched else math.nan,
            "pnl_delta_bbo_vs_official_usd": bbo_pnl - float(row["official_settlement_pnl"]) if matched else math.nan,
        }
    )
    out["entry_backfill_used"] = bool(row.get("entry_bbo_status") != out["entry_bbo_status"] or row.get("entry_repair_stage") != out["entry_repair_stage"])
    out["exit_backfill_used"] = bool(row.get("exit_bbo_status") != out["exit_bbo_status"] or row.get("exit_repair_stage") != out["exit_repair_stage"])
    out["long_wait_quote_used"] = bool(
        (pd.notna(out.get("entry_seconds_away")) and float(out["entry_seconds_away"]) > PRODUCTION_MAX_WAIT_SECONDS)
        or (pd.notna(out.get("exit_seconds_away")) and float(out["exit_seconds_away"]) > PRODUCTION_MAX_WAIT_SECONDS)
    )
    return out


def targeted_backfill(v35_replay: pd.DataFrame, store: TargetedBookStore) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for _, row in v35_replay.iterrows():
        if bool(row["bbo_mbp_matched"]):
            out = dict(row.to_dict())
            out["entry_backfill_used"] = False
            out["exit_backfill_used"] = False
            out["long_wait_quote_used"] = bool(
                (pd.notna(out.get("entry_seconds_away")) and float(out["entry_seconds_away"]) > PRODUCTION_MAX_WAIT_SECONDS)
                or (pd.notna(out.get("exit_seconds_away")) and float(out["exit_seconds_away"]) > PRODUCTION_MAX_WAIT_SECONDS)
            )
            rows.append(out)
            continue

        entry = side_from_existing(row, "entry")
        exit_ = side_from_existing(row, "exit")
        if entry.get("status") != "matched":
            entry = candidate_quote(
                store,
                str(row["front_symbol"]),
                pd.Timestamp(row["entry_anchor_ts"]),
                float(row["entry_anchor_price"]),
            )
        if exit_.get("status") != "matched":
            exit_ = candidate_quote(
                store,
                str(row["exit_symbol"]),
                pd.Timestamp(row["exit_anchor_ts"]),
                float(row["exit_anchor_price"]),
            )
        rows.append(recompute_trade(row, entry, exit_))
    return pd.DataFrame(rows)


def build_cost_stress(bbo: pd.DataFrame, total_signals: int) -> list[dict[str, Any]]:
    return v34.build_cost_stress(bbo, total_signals=total_signals)


def build_summary(v35_summary: dict[str, Any], bbo: pd.DataFrame, stress: list[dict[str, Any]]) -> dict[str, Any]:
    replay, v131_summary = v33.load_inputs()
    summary = v34.build_summary(replay, bbo, stress, v131_summary)
    matched = bbo[bbo["bbo_mbp_matched"]].copy()
    total_v131 = int(v35_summary["coverage"]["v131_executed"])
    coverage = float(len(matched) / total_v131) if total_v131 else 0.0
    long_wait = matched[matched.get("long_wait_quote_used", pd.Series(False, index=matched.index)).astype(bool)]
    production_matched = matched[~matched.get("long_wait_quote_used", pd.Series(False, index=matched.index)).astype(bool)]

    summary["version"] = VERSION
    summary["generated_at"] = datetime.utcnow().isoformat() + "Z"
    summary["source"]["baseline"] = "V1.35 clean quote coverage repair output"
    summary["source"]["repair_method"] = "targeted backfill for V1.35 missing or dirty clean-quote legs only"
    summary["source"]["lookahead_minutes"] = LOOKAHEAD_MINUTES
    summary["source"]["quote_max_wait_seconds"] = QUOTE_MAX_WAIT_SECONDS
    summary["source"]["production_max_wait_seconds"] = PRODUCTION_MAX_WAIT_SECONDS
    summary["source"]["alt_contract_steps"] = ALT_CONTRACT_STEPS
    summary["source"]["alt_max_price_dist_usd"] = ALT_MAX_PRICE_DIST_USD
    summary["source"]["alt_max_price_dist_bps"] = ALT_MAX_PRICE_DIST_BPS
    summary["source"]["q_or_trailing_tuning"] = "not_allowed_in_v1_36"
    summary["v135_reference"] = v35_summary
    summary["coverage"]["v135_matched"] = int(v35_summary["coverage"]["bbo_mbp_matched"])
    summary["coverage"]["bbo_mbp_matched"] = int(len(matched))
    summary["coverage"]["bbo_mbp_missing"] = int(total_v131 - len(matched))
    summary["coverage"]["coverage_of_v131_executed"] = coverage
    summary["coverage"]["newly_backfilled_trades"] = int(len(matched) - int(v35_summary["coverage"]["bbo_mbp_matched"]))
    summary["coverage"]["long_wait_quote_trades"] = int(len(long_wait))
    summary["coverage"]["production_wait_matched"] = int(len(production_matched))
    summary["coverage"]["production_wait_coverage_of_v131_executed"] = float(len(production_matched) / total_v131) if total_v131 else 0.0

    route_counts = []
    for side in ["entry", "exit"]:
        route_counts.append(
            {
                "side": side,
                "original_contract_clean": int(((bbo[f"{side}_route"] == "original") & bbo["bbo_mbp_matched"]).sum()),
                "adjacent_contract_clean": int(((bbo[f"{side}_route"] != "original") & bbo["bbo_mbp_matched"]).sum()),
                "backfill_used": int((bbo.get(f"{side}_backfill_used", pd.Series(False, index=bbo.index))).astype(bool).sum()),
                "missing_or_dirty": int((~bbo["bbo_mbp_matched"]).sum()),
            }
        )
    summary["route_audit"] = route_counts

    # V1.36 promotion still requires 80% total clean quote coverage and positive
    # economics. Long-wait fills are reported but not hidden.
    summary["gate"]["actual"]["bbo_mbp_coverage_of_v131_executed"] = coverage
    summary["gate"]["actual"]["long_wait_quote_trades"] = int(len(long_wait))
    summary["gate"]["actual"]["production_wait_coverage_of_v131_executed"] = summary["coverage"]["production_wait_coverage_of_v131_executed"]
    gate_passed = (
        coverage >= 0.80
        and summary["gate"]["actual"]["bbo_bidask_net_pnl_usd"] > 0
        and summary["gate"]["actual"]["bbo_bidask_2x_fee_net_pnl_usd"] > 0
        and (summary["gate"]["actual"]["stress_2x_fee_plus_1bps_net_pnl_usd"] or -1) > 0
        and summary["gate"]["actual"]["pnl_corr_vs_v131_anchor"] >= 0.90
        and summary["gate"]["actual"]["sign_match_vs_v131_anchor"] >= 0.90
        and summary["gate"]["actual"]["rolling_bbo_net_pnl_usd"] > 0
        and summary["gate"]["actual"]["holdout_bbo_net_pnl_usd"] > 0
    )
    summary["gate"]["passed"] = bool(gate_passed)
    if gate_passed:
        summary["status"] = "gold_clean_quote_targeted_backfill_candidate"
        summary["decision"] = "promote_targeted_clean_quote_cost_layer_for_paper_candidate"
    elif coverage < 0.80:
        summary["status"] = "gold_clean_quote_targeted_backfill_watchlist_insufficient_coverage"
        summary["decision"] = "keep_v1_31_until_clean_quote_coverage_reaches_gate"
    else:
        summary["status"] = "gold_clean_quote_targeted_backfill_not_promoted_keep_v131"
        summary["decision"] = "keep_v1_31_skip_uncovered_baseline"
    summary["next_step"] = (
        "If V1.36 still misses the coverage gate, acquire exact BBO/MBP slices for the remaining dirty legs; "
        "do not tune Q/trailing before executable quote coverage is closed."
    )
    return clean_json(summary)


def create_plot(bbo: pd.DataFrame, summary: dict[str, Any], out: Path) -> None:
    matched = bbo[bbo["bbo_mbp_matched"]].copy()
    fig, axes = plt.subplots(2, 2, figsize=(14, 9))
    if not matched.empty:
        ordered = matched.sort_values(["date", "trade_id_v130"]).reset_index(drop=True)
        axes[0, 0].plot(np.cumsum(ordered["anchor_pnl"]), label="V1.31 anchor")
        axes[0, 0].plot(np.cumsum(ordered["bbo_bidask_pnl_usd"]), label="V1.36 clean quote")
        axes[0, 0].legend()
        axes[0, 1].hist(ordered["pnl_delta_bbo_vs_anchor_usd"].dropna(), bins=20)
        wait_minutes = pd.concat([ordered["entry_seconds_away"], ordered["exit_seconds_away"]], ignore_index=True).dropna() / 60.0
        axes[1, 0].hist(wait_minutes, bins=24)
        route_counts = ordered["entry_route"].fillna("missing").value_counts()
        axes[1, 1].bar(route_counts.index.astype(str), route_counts.values)
        axes[1, 1].tick_params(axis="x", rotation=25)
    axes[0, 0].set_title("Cumulative PnL on clean quote subset")
    axes[0, 1].set_title("PnL delta vs V1.31 anchor")
    axes[1, 0].set_title("Clean quote wait minutes")
    axes[1, 1].set_title("Entry route distribution")
    for ax in axes.flat:
        ax.grid(alpha=0.25)
    fig.suptitle(f"{summary['status']} | coverage {summary['coverage']['coverage_of_v131_executed']:.1%}", y=1.02)
    fig.tight_layout()
    fig.savefig(out, dpi=180, bbox_inches="tight")
    plt.close(fig)


def write_report(summary: dict[str, Any]) -> None:
    cov = summary["coverage"]
    m = summary["bbo_bidask_metrics"]
    stress = summary["stress_reference"]
    lines = [
        f"# {VERSION}",
        "",
        "## 定位",
        "",
        "V1.36 只修 V1.35 剩余 clean quote 缺口，不改信号、不改执行锚、不调 Q/trailing。",
        "它对 V1.35 未匹配交易做 targeted backfill：扩大 clean quote 搜索窗口，并允许价格接近冻结锚点的相邻 GC 合约 clean quote。",
        "",
        "## 结果",
        "",
        f"- 状态：`{summary['status']}`",
        f"- 决策：`{summary['decision']}`",
        f"- V1.35 clean quote 匹配：{cov['v135_matched']}",
        f"- V1.36 clean quote 匹配：{cov['bbo_mbp_matched']} / {cov['v131_executed']}，覆盖率 {cov['coverage_of_v131_executed']:.2%}",
        f"- 新增 backfill 交易：{cov['newly_backfilled_trades']}",
        f"- 超过生产等待上限的 long-wait 交易：{cov['long_wait_quote_trades']}",
        f"- 生产等待覆盖率：{cov['production_wait_coverage_of_v131_executed']:.2%}",
        f"- BBO bid/ask 净收益：${m['net_pnl_usd']:.2f}，PF {m['profit_factor']:.3f}",
        f"- 2x fee + 1bps/side 压力净收益：${stress.get('net_pnl_usd', 0.0):.2f}",
        f"- Anchor 相关：{summary['alignment']['pnl_corr_vs_v131_anchor']:.3f}",
        f"- Anchor 方向一致率：{summary['alignment']['sign_match_vs_v131_anchor']:.2%}",
        "",
        "## Gate",
        "",
        f"- passed：{summary['gate']['passed']}",
        f"- actual：`{json.dumps(summary['gate']['actual'], ensure_ascii=False)}`",
        "",
        "## 解释",
        "",
        "如果覆盖率仍低于 80%，剩余瓶颈就是真实 clean BBO/MBP 数据缺口，不能用 dirty quote 或调参替代。",
        "",
        "## 输出文件",
        "",
        "- `hfcd_trading_v1_36_clean_quote_replay.csv`",
        "- `hfcd_trading_v1_36_bbo_fetch_log.csv`",
        "- `hfcd_trading_v1_36_route_audit.csv`",
        "- `hfcd_trading_v1_36_cost_stress_matrix.csv`",
        "- `hfcd_trading_v1_36_summary.json`",
        "- `HFCD_Trading_V1_36_GoldCleanQuoteTargetedBackfill.png`",
    ]
    (OUT_DIR / "HFCD_Trading_V1_36_GoldCleanQuoteTargetedBackfill.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    v35_replay_path = V35_OUT_DIR / "hfcd_trading_v1_35_clean_quote_replay.csv"
    v35_summary_path = V35_OUT_DIR / "hfcd_trading_v1_35_summary.json"
    if not v35_replay_path.exists() or not v35_summary_path.exists():
        raise FileNotFoundError("Run V1.35 before V1.36 targeted backfill.")
    v35_replay = pd.read_csv(v35_replay_path)
    v35_summary = json.loads(v35_summary_path.read_text(encoding="utf-8"))

    store = TargetedBookStore()
    out = targeted_backfill(v35_replay, store)
    stress = build_cost_stress(out, total_signals=70)
    summary = build_summary(v35_summary, out, stress)

    route_audit = v35.build_symbol_route_audit(out)
    stage_audit = v34.build_stage_audit(out)
    write_csv(OUT_DIR / "hfcd_trading_v1_36_bbo_fetch_log.csv", store.fetch_log)
    out.to_csv(OUT_DIR / "hfcd_trading_v1_36_clean_quote_replay.csv", index=False)
    pd.DataFrame(stress).to_csv(OUT_DIR / "hfcd_trading_v1_36_cost_stress_matrix.csv", index=False)
    route_audit.to_csv(OUT_DIR / "hfcd_trading_v1_36_route_audit.csv", index=False)
    stage_audit.to_csv(OUT_DIR / "hfcd_trading_v1_36_coverage_by_stage.csv", index=False)
    (OUT_DIR / "hfcd_trading_v1_36_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    pd.DataFrame([summary]).to_csv(OUT_DIR / "hfcd_trading_v1_36_summary.csv", index=False)
    create_plot(out, summary, OUT_DIR / "HFCD_Trading_V1_36_GoldCleanQuoteTargetedBackfill.png")
    write_report(summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
