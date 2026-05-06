#!/usr/bin/env python3
"""
HFCD Trading V1.35 Gold Clean Quote Coverage Repair.

V1.34 proved that clean BBO/MBP costs preserve the V1.31 edge, but only
covered 60.34% of V1.31 executed trades. V1.35 repairs coverage without
changing signals, Q exits, trailing exits, or the frozen V1.31 execution
anchor.

The only new repair is deterministic symbol routing:
- try the original contract first;
- if the original contract has no clean quote, try adjacent GC contract months;
- accept an alternate contract only if its clean quote is close to the frozen
  V1.31 anchor price.

This is a cost-layer coverage repair, not price optimization.
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


VERSION = "HFCD_Trading_V1_35_GoldCleanQuoteCoverageRepair"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_35_gold_clean_quote_coverage_repair"
CACHE_DIR = OUT_DIR / "cache_bbo_mbp"
V34_SCRIPT = ROOT / "scripts" / "hfcd_trading_v1_34_gold_bbo_mbp_coverage_repair.py"

FETCH_BBO = os.environ.get("HFCD_V135_FETCH_BBO", "1") == "1"
MAX_FETCH_LEGS = int(os.environ.get("HFCD_V135_MAX_FETCH_LEGS", "260"))
LOOKBACK_MINUTES = int(os.environ.get("HFCD_V135_LOOKBACK_MINUTES", "5"))
LOOKAHEAD_MINUTES = int(os.environ.get("HFCD_V135_LOOKAHEAD_MINUTES", "90"))
QUOTE_MAX_WAIT_SECONDS = int(os.environ.get("HFCD_V135_QUOTE_MAX_WAIT_SECONDS", "3600"))
ALT_MAX_PRICE_DIST_USD = float(os.environ.get("HFCD_V135_ALT_MAX_PRICE_DIST_USD", "25.0"))
ALT_MAX_PRICE_DIST_BPS = float(os.environ.get("HFCD_V135_ALT_MAX_PRICE_DIST_BPS", "100.0"))
ALT_CONTRACT_STEPS = int(os.environ.get("HFCD_V135_ALT_CONTRACT_STEPS", "2"))


def import_v34() -> Any:
    spec = importlib.util.spec_from_file_location("hfcd_v34_bbo_coverage", V34_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import {V34_SCRIPT}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


v34 = import_v34()
v33 = v34.v33

# Reuse V1.34 mechanics, but isolate this run's cache and env controls.
v34.OUT_DIR = OUT_DIR
v34.CACHE_DIR = CACHE_DIR
v34.FETCH_BBO = FETCH_BBO
v34.MAX_FETCH_LEGS = MAX_FETCH_LEGS
v34.LOOKBACK_MINUTES = LOOKBACK_MINUTES
v34.LOOKAHEAD_MINUTES = LOOKAHEAD_MINUTES
v34.QUOTE_MAX_WAIT_SECONDS = QUOTE_MAX_WAIT_SECONDS


MONTH_CODES = ["G", "J", "M", "Q", "V", "Z"]
MONTH_TO_NUM = {"G": 2, "J": 4, "M": 6, "Q": 8, "V": 10, "Z": 12}


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
    year = 2020 + int(year_digit)
    month_idx = MONTH_CODES.index(month_code)
    return year, month_idx


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
    seen: set[str] = set()
    out: list[tuple[str, str, int]] = []
    for offset in [0, 1, -1, 2, -2][: 1 + 2 * ALT_CONTRACT_STEPS]:
        candidate = symbol_from_cycle(year, month_idx + offset)
        if candidate in seen:
            continue
        seen.add(candidate)
        label = "original" if offset == 0 else f"adjacent_{offset:+d}"
        out.append((candidate, label, abs(offset)))
    return out


def price_distance(candidate: dict[str, Any], anchor_price: float) -> tuple[float, float]:
    mid = float(candidate.get("mid", math.nan))
    if not math.isfinite(mid) or not math.isfinite(anchor_price) or anchor_price <= 0:
        return math.inf, math.inf
    dist = abs(mid - anchor_price)
    bps = 10_000.0 * dist / anchor_price
    return dist, bps


def accept_candidate(candidate: dict[str, Any], original: str, anchor_price: float) -> bool:
    if candidate.get("status") != "matched":
        return False
    if candidate.get("selected_symbol") == original:
        return True
    dist, bps = price_distance(candidate, anchor_price)
    return dist <= ALT_MAX_PRICE_DIST_USD and bps <= ALT_MAX_PRICE_DIST_BPS


class CoverageBookStore(v34.RepairBookStore):
    """V1.35 store that does not refetch windows already present locally."""

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

        if frames:
            out = pd.concat(frames, ignore_index=True)
            out = out.sort_values("timestamp").drop_duplicates("timestamp").reset_index(drop=True)
            self.loaded[key] = out
            return out, " | ".join(sources)

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
                        self.loaded[key] = part.sort_values("timestamp").drop_duplicates("timestamp").reset_index(drop=True)
                        return self.loaded[key], f"{schema}:{status}:{cache}"

        out = pd.DataFrame()
        self.loaded[key] = out
        return out, "missing_bbo_mbp"


def first_clean_quote_for_candidates(
    store: Any,
    original_symbol: str,
    target: pd.Timestamp,
    anchor_price: float,
) -> dict[str, Any]:
    attempts: list[dict[str, Any]] = []

    original_candidates = adjacent_contracts(original_symbol)
    for symbol, route, route_rank in original_candidates[:1]:
        book, source = store.get_window(symbol, target)
        result = v34.select_first_clean_quote(book, target)
        result = dict(result)
        result["selected_symbol"] = symbol
        result["route"] = route
        result["route_rank"] = route_rank
        result["source"] = source
        dist, bps = price_distance(result, anchor_price)
        result["anchor_price_distance_usd"] = dist
        result["anchor_price_distance_bps"] = bps
        result["accepted"] = accept_candidate(result, original_symbol, anchor_price)
        attempts.append(result)
        if result["accepted"]:
            result["all_attempts"] = attempts
            return result

    for symbol, route, route_rank in original_candidates[1:]:
        book, source = store.get_window(symbol, target)
        result = v34.select_first_clean_quote(book, target)
        result = dict(result)
        result["selected_symbol"] = symbol
        result["route"] = route
        result["route_rank"] = route_rank
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
                int(row["route_rank"]),
                float(row.get("seconds_away", math.inf)) if math.isfinite(float(row.get("seconds_away", math.inf))) else math.inf,
                float(row.get("anchor_price_distance_usd", math.inf)),
            )
        )
        best = accepted[0]
        best["all_attempts"] = attempts
        return best

    # Preserve the most informative failure reason. Prefer original-contract
    # failure so the audit does not hide bad source coverage behind alternates.
    original_attempts = [row for row in attempts if row["selected_symbol"] == original_symbol]
    best_fail = original_attempts[0] if original_attempts else (attempts[0] if attempts else {})
    best_fail = dict(best_fail)
    best_fail["all_attempts"] = attempts
    return best_fail


def replay_with_symbol_routing(replay: pd.DataFrame, store: Any) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for _, tr in replay[replay["matched"]].copy().iterrows():
        entry_ts = v33.anchor_timestamp(str(tr["date"]), int(tr["anchor_minute_of_day"]), float(tr["entry_minutes_away"]))
        exit_ts = v33.anchor_timestamp(str(tr["exit_date"]), int(tr["anchor_minute_of_day"]), float(tr["exit_minutes_away"]))
        entry_anchor_price = float(tr["entry_anchor_price"])
        exit_anchor_price = float(tr["exit_anchor_price"])
        entry = first_clean_quote_for_candidates(store, str(tr["front_symbol"]), entry_ts, entry_anchor_price)
        exit_ = first_clean_quote_for_candidates(store, str(tr["exit_symbol"]), exit_ts, exit_anchor_price)
        matched = entry.get("status") == "matched" and exit_.get("status") == "matched" and entry.get("accepted") and exit_.get("accepted")

        notional = float(tr["notional_usd"]) * float(tr["position_multiplier"])
        fee = notional * float(tr["fee_rate"])
        side = str(tr.get("side", "long")).lower()
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

        rows.append(
            {
                "trade_id_v130": int(tr["trade_id_v130"]),
                "fold": tr["fold"],
                "split": tr["split"],
                "date": tr["date"],
                "exit_date": tr["exit_date"],
                "front_symbol": tr["front_symbol"],
                "exit_symbol": tr["exit_symbol"],
                "entry_selected_symbol": entry.get("selected_symbol"),
                "exit_selected_symbol": exit_.get("selected_symbol"),
                "entry_route": entry.get("route"),
                "exit_route": exit_.get("route"),
                "entry_route_rank": entry.get("route_rank"),
                "exit_route_rank": exit_.get("route_rank"),
                "score": float(tr["score"]),
                "side": side,
                "notional_usd": notional,
                "fee_usd": fee,
                "anchor_pnl": float(tr["anchor_pnl"]),
                "anchor_pnl_2x_cost": float(tr["anchor_pnl_2x_cost"]),
                "official_settlement_pnl": float(tr["official_settlement_pnl"]),
                "entry_anchor_price": entry_anchor_price,
                "exit_anchor_price": exit_anchor_price,
                "entry_anchor_ts": entry_ts.isoformat(),
                "exit_anchor_ts": exit_ts.isoformat(),
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
                "pnl_delta_bbo_vs_anchor_usd": bbo_pnl - float(tr["anchor_pnl"]) if matched else math.nan,
                "pnl_delta_bbo_vs_official_usd": bbo_pnl - float(tr["official_settlement_pnl"]) if matched else math.nan,
            }
        )
    return pd.DataFrame(rows)


def build_symbol_route_audit(bbo: pd.DataFrame) -> pd.DataFrame:
    if bbo.empty:
        return pd.DataFrame()
    audit = bbo.copy()
    audit["route_pair"] = audit["entry_route"].fillna("missing") + " -> " + audit["exit_route"].fillna("missing")
    return (
        audit.groupby(["bbo_mbp_matched", "route_pair", "split"], dropna=False)
        .agg(
            count=("trade_id_v130", "size"),
            anchor_pnl_usd=("anchor_pnl", "sum"),
            bbo_pnl_usd=("bbo_bidask_pnl_usd", "sum"),
            official_pnl_usd=("official_settlement_pnl", "sum"),
            avg_entry_dist_usd=("entry_anchor_price_distance_usd", "mean"),
            avg_exit_dist_usd=("exit_anchor_price_distance_usd", "mean"),
        )
        .reset_index()
    )


def summarize_attempts(bbo: pd.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if bbo.empty:
        return rows
    for side in ["entry", "exit"]:
        rows.append(
            {
                "side": side,
                "original_contract_clean": int(((bbo[f"{side}_route"] == "original") & bbo["bbo_mbp_matched"]).sum()),
                "adjacent_contract_clean": int(((bbo[f"{side}_route"] != "original") & bbo["bbo_mbp_matched"]).sum()),
                "missing_or_dirty": int((~bbo["bbo_mbp_matched"]).sum()),
            }
        )
    return rows


def create_plot(bbo: pd.DataFrame, summary: dict[str, Any], out: Path) -> None:
    matched = bbo[bbo["bbo_mbp_matched"]].copy()
    fig, axes = plt.subplots(2, 2, figsize=(14, 9))
    if not matched.empty:
        ordered = matched.sort_values(["date", "trade_id_v130"]).reset_index(drop=True)
        axes[0, 0].plot(np.cumsum(ordered["anchor_pnl"]), label="V1.31 anchor")
        axes[0, 0].plot(np.cumsum(ordered["bbo_bidask_pnl_usd"]), label="V1.35 routed clean BBO")
        axes[0, 0].legend()
        axes[0, 1].hist(ordered["pnl_delta_bbo_vs_anchor_usd"].dropna(), bins=20)
        route_counts = ordered["entry_route"].fillna("missing").value_counts()
        axes[1, 0].bar(route_counts.index.astype(str), route_counts.values)
        axes[1, 0].tick_params(axis="x", rotation=25)
        waits = pd.concat([ordered["entry_seconds_away"], ordered["exit_seconds_away"]], ignore_index=True).dropna()
        axes[1, 1].hist(waits / 60.0, bins=20)
    axes[0, 0].set_title("Cumulative PnL on clean quote subset")
    axes[0, 1].set_title("PnL delta vs V1.31 anchor")
    axes[1, 0].set_title("Entry route distribution")
    axes[1, 1].set_title("Clean quote wait minutes")
    for ax in axes.flat:
        ax.grid(alpha=0.25)
    fig.suptitle(f"{summary['status']} | coverage {summary['coverage']['coverage_of_v131_executed']:.1%}", y=1.02)
    fig.tight_layout()
    fig.savefig(out, dpi=180, bbox_inches="tight")
    plt.close(fig)


def write_report(summary: dict[str, Any]) -> None:
    cov = summary["coverage"]
    m = summary["bbo_bidask_metrics"]
    align = summary["alignment"]
    split = summary["split"]
    lines = [
        f"# {VERSION}",
        "",
        "## 定位",
        "",
        "V1.35 专门修 clean quote 覆盖率。它不修改 V1.31 入场集合、不修改执行锚点、不调 Q/trailing。",
        "同合约 clean quote 优先；只有同合约失败时，才尝试相邻 GC 合约，并要求候选 clean quote 价格接近 V1.31 冻结锚点。",
        "",
        "## 结论",
        "",
        f"- 状态：`{summary['status']}`",
        f"- 决策：`{summary['decision']}`",
        f"- V1.31 已执行交易：{cov['v131_executed']}",
        f"- clean quote 匹配：{cov['bbo_mbp_matched']}，覆盖率 {cov['coverage_of_v131_executed']:.2%}",
        f"- 相邻合约参与的 clean quote 匹配：{cov['adjacent_route_matched_trades']}",
        f"- BBO bid/ask 净收益：${m['net_pnl_usd']:.2f}，PF {m['profit_factor']:.3f}",
        f"- 2x fee + 1bps/side 压力净收益：${summary['stress_reference'].get('net_pnl_usd', 0.0):.2f}",
        f"- Anchor 相关：{align['pnl_corr_vs_v131_anchor']:.3f}",
        f"- Anchor 方向一致率：{align['sign_match_vs_v131_anchor']:.2%}",
        "",
        "## 分段",
        "",
        f"- rolling：覆盖 {split.get('rolling', {}).get('coverage_rate', 0.0):.2%}，BBO 净收益 ${split.get('rolling', {}).get('bbo_net_pnl_usd', 0.0):.2f}",
        f"- holdout：覆盖 {split.get('holdout', {}).get('coverage_rate', 0.0):.2%}，BBO 净收益 ${split.get('holdout', {}).get('bbo_net_pnl_usd', 0.0):.2f}",
        "",
        "## Gate",
        "",
        f"- passed：{summary['gate']['passed']}",
        f"- actual：`{json.dumps(summary['gate']['actual'], ensure_ascii=False)}`",
        "",
        "## 解释",
        "",
        "如果本版仍不过 80% 覆盖率，下一步不能继续调信号，而应购买/拉取更完整的 BBO/MBP 历史或扩大官方可验证执行锚来源。",
        "",
        "## 输出文件",
        "",
        "- `hfcd_trading_v1_35_clean_quote_replay.csv`",
        "- `hfcd_trading_v1_35_route_audit.csv`",
        "- `hfcd_trading_v1_35_cost_stress_matrix.csv`",
        "- `hfcd_trading_v1_35_summary.json`",
        "- `HFCD_Trading_V1_35_GoldCleanQuoteCoverageRepair.png`",
    ]
    (OUT_DIR / "HFCD_Trading_V1_35_GoldCleanQuoteCoverageRepair.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    replay, v131_summary = v33.load_inputs()
    store = CoverageBookStore()
    routed = replay_with_symbol_routing(replay, store)
    stress = v34.build_cost_stress(routed, total_signals=len(replay))
    route_audit = build_symbol_route_audit(routed)
    stage_audit = v34.build_stage_audit(routed)
    summary = v34.build_summary(replay, routed, stress, v131_summary)
    summary["version"] = VERSION
    summary["generated_at"] = datetime.utcnow().isoformat() + "Z"
    summary["source"]["baseline"] = "V1.31 skip-uncovered execution paper baseline"
    summary["source"]["repair_method"] = "same-contract clean quote first, adjacent GC contract fallback only if close to frozen anchor"
    summary["source"]["alt_contract_steps"] = ALT_CONTRACT_STEPS
    summary["source"]["alt_max_price_dist_usd"] = ALT_MAX_PRICE_DIST_USD
    summary["source"]["alt_max_price_dist_bps"] = ALT_MAX_PRICE_DIST_BPS
    summary["source"]["q_or_trailing_tuning"] = "not_allowed_in_v1_35"
    adjacent_matched = int(
        (
            routed["bbo_mbp_matched"]
            & ((routed["entry_route"].fillna("original") != "original") | (routed["exit_route"].fillna("original") != "original"))
        ).sum()
    )
    summary["coverage"]["adjacent_route_matched_trades"] = adjacent_matched
    summary["route_audit"] = summarize_attempts(routed)
    if summary["gate"]["passed"]:
        summary["status"] = "gold_clean_quote_coverage_repair_candidate"
        summary["decision"] = "promote_v1_35_clean_quote_cost_layer"
    elif summary["coverage"]["coverage_of_v131_executed"] < 0.80:
        summary["status"] = "gold_clean_quote_coverage_watchlist_insufficient_coverage"
        summary["decision"] = "keep_v1_31_until_clean_quote_coverage_reaches_gate"
    else:
        summary["status"] = "gold_clean_quote_coverage_not_promoted_keep_v131"
        summary["decision"] = "keep_v1_31_skip_uncovered_baseline"
    summary["next_step"] = "If coverage remains below 80%, acquire broader BBO/MBP history or official executable anchor coverage before Q/trailing."

    routed.to_csv(OUT_DIR / "hfcd_trading_v1_35_clean_quote_replay.csv", index=False)
    write_csv(OUT_DIR / "hfcd_trading_v1_35_bbo_fetch_log.csv", store.fetch_log)
    route_audit.to_csv(OUT_DIR / "hfcd_trading_v1_35_route_audit.csv", index=False)
    stage_audit.to_csv(OUT_DIR / "hfcd_trading_v1_35_coverage_by_stage.csv", index=False)
    write_csv(OUT_DIR / "hfcd_trading_v1_35_cost_stress_matrix.csv", stress)
    with (OUT_DIR / "hfcd_trading_v1_35_summary.json").open("w", encoding="utf-8") as f:
        json.dump(clean_json(summary), f, ensure_ascii=False, indent=2)
    write_csv(OUT_DIR / "hfcd_trading_v1_35_summary.csv", [clean_json(summary)])
    create_plot(routed, summary, OUT_DIR / "HFCD_Trading_V1_35_GoldCleanQuoteCoverageRepair.png")
    write_report(summary)
    print(json.dumps(clean_json(summary), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
