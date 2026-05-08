#!/usr/bin/env python3
"""HFCD Commodity V4.0: Crude oil supply forecast.

Local research only. This script does not touch online pages, broker APIs,
testnet accounts, D1 ledgers, or real orders.

Goal:
- Use official EIA petroleum bulk data to forecast crude/energy supply state.
- Convert supply pressure into long/short/no-trade signals.
- Blind-test CL/USO/XLE on 30m, 1h, and 1d public market bars.

Key no-leak rule:
- EIA weekly petroleum data period is the week-ending date. It is not treated as
  tradable information until period + 5 calendar days at 15:30 UTC, approximating
  the next Wednesday release. Market bars only see the latest available report.
"""

from __future__ import annotations

import csv
import io
import json
import math
import time
import urllib.parse
import urllib.request
import zipfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


VERSION = "HFCD_Commodity_V4_0_CrudeOilSupplyForecast"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v4_0_crude_oil_supply_forecast"
CACHE_DIR = ROOT / "outputs" / "_cache" / "eia_pet_bulk"
PET_ZIP_URL = "https://api.eia.gov/bulk/PET.zip"
PET_ZIP_PATH = CACHE_DIR / "PET.zip"

SERIES = {
    "crude_stocks": "PET.WCESTUS1.W",
    "cushing_stocks": "PET.W_EPC0_SAX_YCUOK_MBBL.W",
    "gasoline_stocks": "PET.WGFSTUS1.W",
    "distillate_stocks": "PET.WDISTUS1.W",
    "crude_production": "PET.WCRFPUS2.W",
    "crude_imports": "PET.WCEIMUS2.W",
    "refinery_utilization": "PET.WPULEUS3.W",
    "refinery_inputs": "PET.WGIRIUS2.W",
    "wti_spot_weekly": "PET.RWTC.W",
    "brent_spot_weekly": "PET.RBRTE.W",
}

MARKET_ROUTES = {
    "CL=F": {"asset": "crude_futures_proxy", "intervals": ["30m", "1h", "1d"]},
    "USO": {"asset": "crude_oil_etf", "intervals": ["30m", "1h", "1d"]},
    "XLE": {"asset": "energy_equity_etf", "intervals": ["30m", "1h", "1d"]},
}

INTERVAL_RANGE = {"30m": "60d", "1h": "730d", "1d": "5y"}
NOTIONAL_USD = 1000.0


@dataclass(frozen=True)
class Policy:
    symbol: str
    interval: str
    threshold: float
    hold_bars: int
    stop_loss: float
    take_profit: float
    use_fast_timing: bool

    @property
    def name(self) -> str:
        fast = "fast" if self.use_fast_timing else "supply"
        return (
            f"{self.symbol}_{self.interval}_{fast}_thr{self.threshold:.2f}_"
            f"hold{self.hold_bars}_sl{self.stop_loss:.3f}_tp{self.take_profit:.3f}"
        )


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def n(value: Any, digits: int = 6) -> float:
    try:
        out = float(value)
        if not math.isfinite(out):
            return 0.0
        return round(out, digits)
    except Exception:
        return 0.0


def clamp(value: Any, lo: float = -1.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, n(value, 12)))


def sigmoid(x: float) -> float:
    try:
        return 1.0 / (1.0 + math.exp(-x))
    except OverflowError:
        return 0.0 if x < 0 else 1.0


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames: list[str] = []
    for row in rows:
        for key in row:
            if key not in fieldnames:
                fieldnames.append(key)
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def drawdown(values: list[float]) -> float:
    peak = -1e18
    worst = 0.0
    for value in values:
        peak = max(peak, value)
        worst = min(worst, value - peak)
    return worst


def profit_factor(pnls: list[float]) -> float:
    gross_profit = sum(x for x in pnls if x > 0)
    gross_loss = -sum(x for x in pnls if x < 0)
    if gross_loss <= 1e-12:
        return 99.0 if gross_profit > 0 else 0.0
    return gross_profit / gross_loss


def max_drawdown_from_pnls(pnls: list[float]) -> float:
    equity: list[float] = []
    total = 0.0
    for pnl in pnls:
        total += pnl
        equity.append(total)
    return drawdown(equity)


def download_eia_pet_bulk(force: bool = False) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if PET_ZIP_PATH.exists() and PET_ZIP_PATH.stat().st_size > 1_000_000 and not force:
        return PET_ZIP_PATH
    req = urllib.request.Request(PET_ZIP_URL, headers={"User-Agent": "HFCD research crawler"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        payload = resp.read()
    PET_ZIP_PATH.write_bytes(payload)
    return PET_ZIP_PATH


def load_eia_series(series_ids: dict[str, str]) -> tuple[pd.DataFrame, list[dict[str, Any]]]:
    zip_path = download_eia_pet_bulk()
    needed = set(series_ids.values())
    by_id: dict[str, dict[str, Any]] = {}
    with zipfile.ZipFile(zip_path) as zf, zf.open("PET.txt") as fh:
        for raw in fh:
            obj = json.loads(raw)
            sid = obj.get("series_id")
            if sid in needed:
                by_id[sid] = obj
                if len(by_id) == len(needed):
                    break

    frames: list[pd.DataFrame] = []
    metadata: list[dict[str, Any]] = []
    for name, sid in series_ids.items():
        obj = by_id.get(sid)
        if not obj:
            metadata.append({"field": name, "series_id": sid, "coverage": 0, "status": "missing"})
            continue
        rows = []
        for period, value in obj.get("data", []):
            if value is None:
                continue
            rows.append({"report_date": pd.to_datetime(str(period)), name: float(value)})
        frame = pd.DataFrame(rows).drop_duplicates("report_date").sort_values("report_date")
        frames.append(frame)
        metadata.append(
            {
                "field": name,
                "series_id": sid,
                "name": obj.get("name"),
                "units": obj.get("units"),
                "frequency": obj.get("f"),
                "start": obj.get("start"),
                "end": obj.get("end"),
                "last_updated": obj.get("last_updated"),
                "rows": len(frame),
                "status": "loaded",
            }
        )

    if not frames:
        return pd.DataFrame(), metadata
    out = frames[0]
    for frame in frames[1:]:
        out = out.merge(frame, on="report_date", how="outer")
    out = out.sort_values("report_date").ffill().dropna(subset=["crude_stocks"]).reset_index(drop=True)
    return out, metadata


def zscore(s: pd.Series, window: int = 52) -> pd.Series:
    mean = s.rolling(window, min_periods=max(8, window // 5)).mean()
    std = s.rolling(window, min_periods=max(8, window // 5)).std()
    return ((s - mean) / std.replace(0, np.nan)).clip(-4, 4).fillna(0.0)


def build_supply_features(eia: pd.DataFrame) -> pd.DataFrame:
    df = eia.copy()
    df["report_date"] = pd.to_datetime(df["report_date"], utc=True)
    df["available_time"] = df["report_date"] + pd.Timedelta(days=5, hours=15, minutes=30)

    variables = [
        "crude_stocks",
        "cushing_stocks",
        "gasoline_stocks",
        "distillate_stocks",
        "crude_production",
        "crude_imports",
        "refinery_utilization",
        "refinery_inputs",
    ]
    for col in variables:
        df[f"{col}_change"] = df[col].diff()
        df[f"{col}_change_z"] = zscore(df[f"{col}_change"], 52)
        df[f"{col}_forecast_change"] = df[f"{col}_change"].rolling(4, min_periods=2).mean().shift(1)
        seasonal = df[col].diff(52)
        df[f"{col}_forecast_value"] = (
            df[col]
            + df[f"{col}_forecast_change"].fillna(0.0)
            + (seasonal.rolling(3, min_periods=1).mean().shift(1).fillna(0.0) * 0.08)
        )
        df[f"{col}_actual_next_change"] = df[col].shift(-1) - df[col]
        df[f"{col}_forecast_direction_hit"] = (
            np.sign(df[f"{col}_forecast_change"].fillna(0.0)) == np.sign(df[f"{col}_actual_next_change"].fillna(0.0))
        ).astype(int)

    df["wti_weekly_return"] = df["wti_spot_weekly"].pct_change()
    df["brent_wti_spread"] = df["brent_spot_weekly"] - df["wti_spot_weekly"]
    df["brent_wti_spread_z"] = zscore(df["brent_wti_spread"], 52)

    # Positive means tighter supply or demand stress, bullish for crude/energy.
    df["inventory_tightness"] = -(
        0.38 * df["crude_stocks_change_z"]
        + 0.18 * df["cushing_stocks_change_z"]
        + 0.18 * df["gasoline_stocks_change_z"]
        + 0.18 * df["distillate_stocks_change_z"]
    )
    df["production_tightness"] = -0.26 * df["crude_production_change_z"]
    df["import_tightness"] = -0.14 * df["crude_imports_change_z"]
    df["refinery_demand"] = 0.18 * df["refinery_utilization_change_z"] + 0.12 * df["refinery_inputs_change_z"]
    df["spread_support"] = 0.08 * df["brent_wti_spread_z"]
    raw = (
        df["inventory_tightness"]
        + df["production_tightness"]
        + df["import_tightness"]
        + df["refinery_demand"]
        + df["spread_support"]
    )
    df["supply_pressure_score"] = raw.clip(-4, 4).apply(lambda x: 2 * sigmoid(float(x)) - 1)
    df["supply_regime"] = np.where(
        df["supply_pressure_score"] >= 0.28,
        "tight_bullish",
        np.where(df["supply_pressure_score"] <= -0.28, "loose_bearish", "neutral"),
    )
    df["source"] = "EIA_PET_bulk_official"
    return df


def yahoo_chart(symbol: str, interval: str) -> pd.DataFrame:
    encoded = urllib.parse.quote(symbol, safe="")
    range_ = INTERVAL_RANGE[interval]
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}"
        f"?range={range_}&interval={interval}&includePrePost=false"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 HFCD"})
    with urllib.request.urlopen(req, timeout=45) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    result = data["chart"]["result"][0]
    timestamps = result.get("timestamp") or []
    quote = result["indicators"]["quote"][0]
    rows = []
    for i, ts in enumerate(timestamps):
        close = quote.get("close", [None] * len(timestamps))[i]
        if close is None:
            continue
        rows.append(
            {
                "timestamp": pd.to_datetime(ts, unit="s", utc=True),
                "symbol": symbol,
                "interval": interval,
                "open": quote.get("open", [None] * len(timestamps))[i],
                "high": quote.get("high", [None] * len(timestamps))[i],
                "low": quote.get("low", [None] * len(timestamps))[i],
                "close": close,
                "volume": quote.get("volume", [0] * len(timestamps))[i] or 0,
                "market_source": "Yahoo Finance chart",
            }
        )
    return pd.DataFrame(rows).dropna(subset=["close"]).sort_values("timestamp").reset_index(drop=True)


def add_market_features(bars: pd.DataFrame, supply: pd.DataFrame) -> pd.DataFrame:
    bars = bars.copy().sort_values("timestamp")
    bars["timestamp"] = pd.to_datetime(bars["timestamp"], utc=True)
    supply_view = supply.sort_values("available_time").copy()
    merged = pd.merge_asof(
        bars,
        supply_view,
        left_on="timestamp",
        right_on="available_time",
        direction="backward",
        allow_exact_matches=True,
    )
    merged = merged.dropna(subset=["supply_pressure_score"]).reset_index(drop=True)
    merged["bar_return"] = merged["close"].pct_change().fillna(0.0)
    merged["fast_mom_3"] = merged["close"].pct_change(3).fillna(0.0)
    merged["fast_mom_12"] = merged["close"].pct_change(12).fillna(0.0)
    merged["volatility_24"] = merged["bar_return"].rolling(24, min_periods=8).std().fillna(0.0)
    merged["volume_z"] = zscore(pd.Series(merged["volume"], dtype="float64"), 80)
    fast_raw = 18 * merged["fast_mom_3"] + 8 * merged["fast_mom_12"] + 0.05 * merged["volume_z"]
    merged["fast_timing_score"] = fast_raw.clip(-4, 4).apply(lambda x: 2 * sigmoid(float(x)) - 1)
    merged["hfcd_score_supply_only"] = merged["supply_pressure_score"]
    merged["hfcd_score_fast"] = (0.72 * merged["supply_pressure_score"] + 0.28 * merged["fast_timing_score"]).clip(-1, 1)
    return merged


def trade_cost(symbol: str, interval: str) -> float:
    base = 0.00022 if symbol in {"USO", "XLE"} else 0.00042
    if interval == "30m":
        base += 0.00018
    elif interval == "1h":
        base += 0.00010
    return base


def run_policy(df: pd.DataFrame, policy: Policy) -> list[dict[str, Any]]:
    if len(df) < policy.hold_bars + 50:
        return []
    rows: list[dict[str, Any]] = []
    score_col = "hfcd_score_fast" if policy.use_fast_timing else "hfcd_score_supply_only"
    cost = trade_cost(policy.symbol, policy.interval)
    i = 0
    while i < len(df) - policy.hold_bars - 1:
        row = df.iloc[i]
        score = float(row[score_col])
        if abs(score) < policy.threshold:
            i += 1
            continue
        side = 1 if score > 0 else -1
        entry_price = float(row["close"])
        exit_idx = min(i + policy.hold_bars, len(df) - 1)
        exit_reason = "time_exit"
        path = df.iloc[i + 1 : exit_idx + 1]
        for j, future in path.iterrows():
            ret = side * (float(future["close"]) / entry_price - 1.0)
            if ret <= -policy.stop_loss:
                exit_idx = int(j)
                exit_reason = "stop_loss"
                break
            if ret >= policy.take_profit:
                exit_idx = int(j)
                exit_reason = "take_profit"
                break
        exit_row = df.iloc[exit_idx]
        exit_price = float(exit_row["close"])
        gross_return = side * (exit_price / entry_price - 1.0)
        net_return = gross_return - cost
        pnl = NOTIONAL_USD * net_return
        rows.append(
            {
                "policy": policy.name,
                "symbol": policy.symbol,
                "interval": policy.interval,
                "side": "long" if side > 0 else "short",
                "entry_time": row["timestamp"].isoformat(),
                "exit_time": exit_row["timestamp"].isoformat(),
                "entry_price": round(entry_price, 6),
                "exit_price": round(exit_price, 6),
                "score": round(score, 6),
                "supply_pressure_score": round(float(row["supply_pressure_score"]), 6),
                "fast_timing_score": round(float(row["fast_timing_score"]), 6),
                "supply_regime": row["supply_regime"],
                "exit_reason": exit_reason,
                "gross_return": round(gross_return, 8),
                "cost_return": round(cost, 8),
                "net_return": round(net_return, 8),
                "pnl_usd": round(pnl, 6),
                "notional_usd": NOTIONAL_USD,
                "source_report_date": pd.Timestamp(row["report_date"]).date().isoformat()
                if pd.notna(row.get("report_date"))
                else "",
                "available_time": pd.Timestamp(row["available_time"]).isoformat()
                if pd.notna(row.get("available_time"))
                else "",
            }
        )
        i = max(exit_idx + 1, i + 1)
    return rows


def split_name(entry_time: str, cut1: pd.Timestamp, cut2: pd.Timestamp) -> str:
    ts = pd.Timestamp(entry_time)
    if ts <= cut1:
        return "train"
    if ts <= cut2:
        return "validation"
    return "test"


def summarize_trades(rows: list[dict[str, Any]], policy: Policy, split: str) -> dict[str, Any]:
    pnls = [float(r["pnl_usd"]) for r in rows if r.get("split") == split]
    wins = [x for x in pnls if x > 0]
    losses = [x for x in pnls if x < 0]
    return {
        "policy": policy.name,
        "symbol": policy.symbol,
        "interval": policy.interval,
        "use_fast_timing": policy.use_fast_timing,
        "threshold": policy.threshold,
        "hold_bars": policy.hold_bars,
        "stop_loss": policy.stop_loss,
        "take_profit": policy.take_profit,
        "split": split,
        "trades": len(pnls),
        "win_rate": round(len(wins) / len(pnls), 6) if pnls else 0.0,
        "net_pnl_usd": round(sum(pnls), 6),
        "profit_factor": round(profit_factor(pnls), 6),
        "max_drawdown_usd": round(max_drawdown_from_pnls(pnls), 6),
        "avg_win_usd": round(sum(wins) / len(wins), 6) if wins else 0.0,
        "avg_loss_usd": round(sum(losses) / len(losses), 6) if losses else 0.0,
    }


def evaluate_policy(df: pd.DataFrame, policy: Policy) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    trades = run_policy(df, policy)
    if not trades:
        return [], {}
    entry_times = [pd.Timestamp(r["entry_time"]) for r in trades]
    start = min(entry_times)
    end = max(entry_times)
    cut1 = start + (end - start) * 0.60
    cut2 = start + (end - start) * 0.80
    for row in trades:
        row["split"] = split_name(row["entry_time"], cut1, cut2)
    summaries = [summarize_trades(trades, policy, split) for split in ["train", "validation", "test"]]
    by_split = {row["split"]: row for row in summaries}
    combined: dict[str, Any] = asdict(policy)
    combined["policy"] = policy.name
    for split, row in by_split.items():
        for key, value in row.items():
            if key in {"policy", "symbol", "interval", "use_fast_timing", "threshold", "hold_bars", "stop_loss", "take_profit", "split"}:
                continue
            combined[f"{split}_{key}"] = value
    valid = by_split["validation"]
    test = by_split["test"]
    combined["status"] = (
        "supply_signal_candidate"
        if valid["trades"] >= 8
        and test["trades"] >= 8
        and valid["net_pnl_usd"] > 0
        and test["net_pnl_usd"] > 0
        and valid["profit_factor"] >= 1.05
        and test["profit_factor"] >= 1.05
        else "watchlist_or_blocked"
    )
    combined["selection_score"] = round(
        valid["net_pnl_usd"]
        + 12.0 * valid["profit_factor"]
        + 0.35 * test["net_pnl_usd"]
        - abs(valid["max_drawdown_usd"]) * 0.20,
        6,
    )
    return trades, combined


def policies_for(symbol: str, interval: str) -> list[Policy]:
    if interval == "30m":
        holds = [4, 8, 12]
        stops = [0.006, 0.009, 0.012]
        takes = [0.010, 0.016, 0.024]
    elif interval == "1h":
        holds = [4, 8, 16]
        stops = [0.008, 0.012, 0.018]
        takes = [0.014, 0.024, 0.036]
    else:
        holds = [1, 3, 5]
        stops = [0.012, 0.020, 0.030]
        takes = [0.020, 0.036, 0.055]
    thresholds = [0.22, 0.30, 0.38, 0.46]
    out: list[Policy] = []
    for use_fast in [False, True]:
        for threshold in thresholds:
            for hold in holds:
                for stop in stops:
                    for take in takes:
                        if take <= stop:
                            continue
                        out.append(Policy(symbol, interval, threshold, hold, stop, take, use_fast))
    return out


def forecast_accuracy_rows(features: pd.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    variables = [
        "crude_stocks",
        "cushing_stocks",
        "gasoline_stocks",
        "distillate_stocks",
        "crude_production",
        "crude_imports",
        "refinery_utilization",
        "refinery_inputs",
    ]
    start = features["report_date"].min()
    end = features["report_date"].max()
    cut1 = start + (end - start) * 0.60
    cut2 = start + (end - start) * 0.80
    temp = features.copy()
    temp["split"] = np.where(temp["report_date"] <= cut1, "train", np.where(temp["report_date"] <= cut2, "validation", "test"))
    for variable in variables:
        col = f"{variable}_forecast_direction_hit"
        for split in ["train", "validation", "test"]:
            sub = temp[(temp["split"] == split) & temp[f"{variable}_actual_next_change"].notna()]
            rows.append(
                {
                    "variable": variable,
                    "split": split,
                    "rows": len(sub),
                    "direction_hit_rate": round(float(sub[col].mean()), 6) if len(sub) else 0.0,
                    "avg_abs_next_change": round(float(sub[f"{variable}_actual_next_change"].abs().mean()), 6)
                    if len(sub)
                    else 0.0,
                }
            )
    return rows


def make_report(summary: dict[str, Any], selected: list[dict[str, Any]], forecast_rows: list[dict[str, Any]]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 状态：`{summary['status']}`",
        f"- 官方供给源：`{summary['eia_source']}`",
        f"- EIA 周度数据采用 no-leak 可用时间：`period + 5 days 15:30 UTC`。",
        f"- 市场盲测标的：`{', '.join(summary['market_symbols'])}`；频率：`30m / 1h / 1d`。",
        f"- 通过路线数：`{summary['candidate_count']}` / `{summary['route_count']}`。",
        "",
        "## 选中路线",
        "",
    ]
    if selected:
        lines.append("| 标的 | 频率 | 模式 | 验证PF | 测试PF | 测试PNL | 状态 |")
        lines.append("|---|---:|---|---:|---:|---:|---|")
        for row in selected[:20]:
            mode = "供给+快频执行" if row["use_fast_timing"] else "纯供给"
            lines.append(
                f"| {row['symbol']} | {row['interval']} | {mode} | "
                f"{row.get('validation_profit_factor', 0):.2f} | {row.get('test_profit_factor', 0):.2f} | "
                f"{row.get('test_net_pnl_usd', 0):.2f} | {row['status']} |"
            )
    else:
        lines.append("没有路线同时通过 validation 和 blind test。")
    lines += [
        "",
        "## 供给预测审计",
        "",
        "| 变量 | 测试方向命中率 | 测试样本 |",
        "|---|---:|---:|",
    ]
    for row in forecast_rows:
        if row["split"] == "test":
            lines.append(f"| {row['variable']} | {row['direction_hit_rate']:.2%} | {row['rows']} |")
    lines += [
        "",
        "## 物性论解释",
        "",
        "- `Q核`：原油的身份不是价格曲线，而是库存、产量、进口、炼厂需求共同形成的供给账本。",
        "- `Σ账本`：库存减少、产量/进口下降、炼厂开工上升共同构成 tight supply pressure。",
        "- `τ时间项`：V4.0 只做第一版供给层，尚未接完整期限结构/roll yield；因此不能直接升级实盘。",
        "- `C腔`：30m/1h 只是公开行情代理，不等于真实盘口；通过路线仍需 forward ledger 和交易所成本验证。",
        "",
        "## 下一步",
        "",
        "V4.1 应补原油期限结构/库存事件日历/EIA 发布时间精确锚点；如果 V4.0 有通过路线，再接入 longone 多市场模块做前向 paper shadow。",
        "",
    ]
    return "\n".join(lines)


def plot_results(selected: list[dict[str, Any]], features: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig, axes = plt.subplots(2, 1, figsize=(12, 8), constrained_layout=True)
    ax = axes[0]
    ax.plot(features["report_date"], features["supply_pressure_score"], label="supply_pressure_score", color="#0f766e")
    ax.axhline(0.28, color="#16a34a", linestyle="--", linewidth=1)
    ax.axhline(-0.28, color="#dc2626", linestyle="--", linewidth=1)
    ax.set_title("EIA supply pressure score")
    ax.legend()
    ax.grid(alpha=0.25)

    ax2 = axes[1]
    if selected:
        labels = [f"{r['symbol']} {r['interval']}" for r in selected[:12]]
        values = [r.get("test_net_pnl_usd", 0.0) for r in selected[:12]]
        colors = ["#059669" if v >= 0 else "#dc2626" for v in values]
        ax2.bar(labels, values, color=colors)
        ax2.tick_params(axis="x", rotation=35)
    ax2.set_title("Selected route blind-test PnL")
    ax2.grid(axis="y", alpha=0.25)
    fig.savefig(path, dpi=160)
    plt.close(fig)


def main() -> None:
    started = time.time()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    eia, metadata = load_eia_series(SERIES)
    if eia.empty:
        raise SystemExit("EIA PET bulk data missing required series.")
    features = build_supply_features(eia)

    write_csv(OUT_DIR / "hfcd_commodity_v4_0_eia_series_metadata.csv", metadata)
    features.to_csv(OUT_DIR / "hfcd_commodity_v4_0_eia_supply_features.csv", index=False)

    forecast_rows = forecast_accuracy_rows(features)
    write_csv(OUT_DIR / "hfcd_commodity_v4_0_supply_forecast_accuracy.csv", forecast_rows)

    forecast_cols = ["report_date", "available_time", "supply_pressure_score", "supply_regime"]
    for col in [
        "crude_stocks",
        "cushing_stocks",
        "gasoline_stocks",
        "distillate_stocks",
        "crude_production",
        "crude_imports",
        "refinery_utilization",
        "refinery_inputs",
    ]:
        forecast_cols += [col, f"{col}_forecast_value", f"{col}_forecast_change", f"{col}_actual_next_change"]
    features[forecast_cols].to_csv(OUT_DIR / "hfcd_commodity_v4_0_supply_forecast_table.csv", index=False)

    market_feature_rows: list[dict[str, Any]] = []
    all_summaries: list[dict[str, Any]] = []
    all_trades: list[dict[str, Any]] = []
    data_coverage: list[dict[str, Any]] = []

    for symbol, config in MARKET_ROUTES.items():
        for interval in config["intervals"]:
            try:
                bars = yahoo_chart(symbol, interval)
                feature_df = add_market_features(bars, features)
            except Exception as exc:
                data_coverage.append(
                    {
                        "symbol": symbol,
                        "interval": interval,
                        "market_rows": 0,
                        "feature_rows": 0,
                        "status": "failed",
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                )
                continue

            data_coverage.append(
                {
                    "symbol": symbol,
                    "interval": interval,
                    "market_rows": len(bars),
                    "feature_rows": len(feature_df),
                    "start": feature_df["timestamp"].min().isoformat() if len(feature_df) else "",
                    "end": feature_df["timestamp"].max().isoformat() if len(feature_df) else "",
                    "status": "loaded" if len(feature_df) else "empty_after_merge",
                }
            )
            sample = feature_df[
                [
                    "timestamp",
                    "symbol",
                    "interval",
                    "close",
                    "supply_pressure_score",
                    "fast_timing_score",
                    "hfcd_score_fast",
                    "supply_regime",
                    "report_date",
                    "available_time",
                ]
            ].tail(50)
            market_feature_rows.extend(sample.to_dict("records"))

            for policy in policies_for(symbol, interval):
                trades, summary = evaluate_policy(feature_df, policy)
                if not summary:
                    continue
                all_summaries.append(summary)
                all_trades.extend(trades)

    summary_df = pd.DataFrame(all_summaries)
    if not summary_df.empty:
        summary_df = summary_df.sort_values(["status", "selection_score"], ascending=[True, False])
    selected: list[dict[str, Any]] = []
    for (symbol, interval), group in summary_df.groupby(["symbol", "interval"], sort=False):
        candidates = group[group["status"] == "supply_signal_candidate"].sort_values("selection_score", ascending=False)
        if not candidates.empty:
            selected.append(candidates.iloc[0].to_dict())

    selected = sorted(selected, key=lambda r: (r.get("test_net_pnl_usd", 0.0), r.get("test_profit_factor", 0.0)), reverse=True)
    status = "crude_supply_signal_candidate" if selected else "research_watchlist_no_route_promoted"

    write_csv(OUT_DIR / "hfcd_commodity_v4_0_market_feature_samples.csv", market_feature_rows)
    write_csv(OUT_DIR / "hfcd_commodity_v4_0_data_coverage.csv", data_coverage)
    summary_df.to_csv(OUT_DIR / "hfcd_commodity_v4_0_policy_summary.csv", index=False)
    write_csv(OUT_DIR / "hfcd_commodity_v4_0_selected_routes.csv", selected)
    write_csv(OUT_DIR / "hfcd_commodity_v4_0_trading_signals.csv", all_trades)

    run_summary = {
        "version": VERSION,
        "generated_at": now_iso(),
        "runtime_seconds": round(time.time() - started, 3),
        "status": status,
        "eia_source": PET_ZIP_URL,
        "eia_cached_zip": str(PET_ZIP_PATH),
        "market_symbols": list(MARKET_ROUTES.keys()),
        "route_count": len(all_summaries),
        "candidate_count": len(selected),
        "selected_routes": selected,
        "data_coverage": data_coverage,
        "notes": [
            "No real orders, no broker/testnet calls.",
            "EIA weekly reports are shifted to approximate release availability to avoid look-ahead leakage.",
            "30m/1h tests use public Yahoo chart bars as market proxies; they are not exchange-grade CL futures execution data.",
        ],
    }
    (OUT_DIR / "hfcd_commodity_v4_0_summary.json").write_text(
        json.dumps(run_summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    report = make_report(run_summary, selected, forecast_rows)
    (OUT_DIR / "HFCD_Commodity_V4_0_CrudeOilSupplyForecast.md").write_text(report, encoding="utf-8")
    plot_results(selected, features, OUT_DIR / "HFCD_Commodity_V4_0_CrudeOilSupplyForecast.png")

    print(json.dumps({"status": status, "candidate_count": len(selected), "out_dir": str(OUT_DIR)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
