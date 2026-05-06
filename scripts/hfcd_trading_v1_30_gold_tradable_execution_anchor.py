#!/usr/bin/env python3
"""
HFCD Trading V1.30 Gold Tradable Execution Anchor.

V1.29 rebuilt the gold baseline on official CME settlement. This stage does not
improve the trading signal and does not tune Q/trailing. It asks a narrower
execution question:

Can a pre-defined, tradable minute/VWAP anchor reconstruct the official
settlement baseline closely enough to become the next execution layer?
"""

from __future__ import annotations

import csv
import json
import math
import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_30_GoldTradableExecutionAnchor"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_30_gold_tradable_execution_anchor"
V129_DIR = ROOT / "outputs" / "hfcd_trading_v1_29_gold_official_settlement_baseline_replay"
V127_DIR = ROOT / "outputs" / "hfcd_trading_v1_27_gold_settlement_anchor_calibration"
V126_DIR = ROOT / "outputs" / "hfcd_trading_v1_26_gold_close_to_close_minute_alignment"

V129_SELECTED_TRADES = V129_DIR / "hfcd_trading_v1_29_selected_trades.csv"
V127_ANCHOR_CANDIDATES = V127_DIR / "hfcd_trading_v1_27_fixed_anchor_candidates.csv"
V126_CACHE_CTC = V126_DIR / "cache_ctc"
V127_CACHE_EXTRA = V127_DIR / "cache_extra_legs"
V130_CACHE = OUT_DIR / "cache_anchor_windows"
DATASET = "GLBX.MDP3"
FETCH_MISSING = os.environ.get("HFCD_V130_FETCH_MISSING", "1") == "1"


@dataclass(frozen=True)
class AnchorSpec:
    name: str
    anchor_minute_of_day: int
    method: str
    window_minutes: int = 0
    nearest_tolerance_minutes: int = 15

    @property
    def anchor_time_utc(self) -> str:
        return f"{self.anchor_minute_of_day // 60:02d}:{self.anchor_minute_of_day % 60:02d}"


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


def json_clean(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): json_clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [json_clean(v) for v in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        v = float(value)
        return v if math.isfinite(v) else None
    if isinstance(value, (pd.Timestamp,)):
        return value.isoformat()
    if pd.isna(value) if not isinstance(value, (str, bytes, bool, type(None))) else False:
        return None
    return value


def max_drawdown(values: list[float]) -> float:
    if not values:
        return 0.0
    equity = np.cumsum(values)
    peak = np.maximum.accumulate(equity)
    return float((equity - peak).min())


def metrics(values: list[float]) -> dict[str, Any]:
    wins = [v for v in values if v > 0]
    losses = [v for v in values if v < 0]
    gross_win = float(sum(wins))
    gross_loss = float(abs(sum(losses)))
    return {
        "trades": len(values),
        "win_rate": float(len(wins) / len(values)) if values else 0.0,
        "net_pnl_usd": float(sum(values)),
        "profit_factor": float(gross_win / gross_loss) if gross_loss > 0 else (999.0 if gross_win > 0 else 0.0),
        "max_drawdown_usd": max_drawdown(values),
        "gross_win_usd": gross_win,
        "gross_loss_usd": gross_loss,
        "avg_pnl_usd": float(np.mean(values)) if values else 0.0,
    }


def safe_corr(a: pd.Series, b: pd.Series) -> float:
    tmp = pd.DataFrame({"a": pd.to_numeric(a, errors="coerce"), "b": pd.to_numeric(b, errors="coerce")}).dropna()
    if len(tmp) < 3 or tmp["a"].std() == 0 or tmp["b"].std() == 0:
        return 0.0
    return float(tmp["a"].corr(tmp["b"]))


def sign_match(a: pd.Series, b: pd.Series) -> float:
    tmp = pd.DataFrame({"a": pd.to_numeric(a, errors="coerce"), "b": pd.to_numeric(b, errors="coerce")}).dropna()
    if tmp.empty:
        return 0.0
    return float((np.sign(tmp["a"]) == np.sign(tmp["b"])).mean())


def load_selected_trades() -> pd.DataFrame:
    if not V129_SELECTED_TRADES.exists():
        raise FileNotFoundError(V129_SELECTED_TRADES)
    df = pd.read_csv(V129_SELECTED_TRADES)
    df = df[(df["variant"] == "official_v1_20_base_floor_1p00") & (df["official_coverage"] == "matched")].copy()
    if df.empty:
        raise ValueError("No V1.29 official_v1_20_base_floor_1p00 matched trades found.")
    df["date"] = pd.to_datetime(df["date"], errors="coerce").dt.date.astype(str)
    df["exit_date"] = pd.to_datetime(df["exit_date"], errors="coerce").dt.date.astype(str)
    for col in [
        "notional_usd",
        "position_multiplier",
        "fee_rate",
        "score",
        "entry_settlement_price",
        "exit_settlement_price",
        "official_settlement_pnl",
    ]:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0)
    df["trade_id_v130"] = np.arange(len(df))
    df["split"] = np.where(df["fold"].astype(str).eq("holdout"), "holdout", "rolling")
    return df.sort_values(["date", "fold"]).reset_index(drop=True)


def load_seed_anchor_minutes() -> list[int]:
    if not V127_ANCHOR_CANDIDATES.exists():
        return [23 * 60 + 25, 23 * 60 + 35, 23 * 60 + 45, 0, 5, 65]
    df = pd.read_csv(V127_ANCHOR_CANDIDATES)
    df["anchor_minute_of_day"] = pd.to_numeric(df["anchor_minute_of_day"], errors="coerce")
    df["all_matched"] = pd.to_numeric(df.get("all_matched"), errors="coerce").fillna(0)
    df["rolling_score"] = pd.to_numeric(df.get("rolling_score"), errors="coerce").fillna(-999)
    # Prefer high-coverage anchors, but keep the prior high-score sparse anchors as audit checks.
    high_coverage = (
        df[df["all_matched"] >= max(20, df["all_matched"].quantile(0.75))]
        .sort_values(["rolling_score", "all_matched"], ascending=False)
        .head(18)
    )
    sparse_high_score = df.sort_values("rolling_score", ascending=False).head(8)
    minutes = pd.concat([high_coverage, sparse_high_score])["anchor_minute_of_day"].dropna().astype(int).tolist()
    # Add robust Globex/CME settlement-near times.
    minutes.extend([20 * 60, 21 * 60, 22 * 60, 22 * 60 + 30, 23 * 60, 23 * 60 + 30, 0, 30, 60])
    return sorted(set(m for m in minutes if 0 <= m < 24 * 60))


def build_anchor_specs() -> list[AnchorSpec]:
    specs: list[AnchorSpec] = []
    for minute in load_seed_anchor_minutes():
        t = f"{minute // 60:02d}{minute % 60:02d}"
        specs.append(AnchorSpec(name=f"nearest_{t}_tol15", anchor_minute_of_day=minute, method="nearest", window_minutes=0))
        specs.append(
            AnchorSpec(
                name=f"next_after_{t}_wait240",
                anchor_minute_of_day=minute,
                method="next_after",
                window_minutes=0,
                nearest_tolerance_minutes=240,
            )
        )
        for window in (15, 30, 60):
            specs.append(
                AnchorSpec(
                    name=f"vwap_{t}_w{window}",
                    anchor_minute_of_day=minute,
                    method="vwap",
                    window_minutes=window,
                )
            )
    return specs


def normalize_feed(path: Path) -> pd.DataFrame:
    if not path.exists() or path.stat().st_size == 0:
        return pd.DataFrame()
    try:
        raw = pd.read_csv(path)
    except Exception:
        return pd.DataFrame()
    if raw.empty:
        return pd.DataFrame()
    ts_col = "timestamp" if "timestamp" in raw.columns else ("ts_event" if "ts_event" in raw.columns else raw.columns[0])
    out = raw.copy()
    out["timestamp"] = pd.to_datetime(out[ts_col], errors="coerce", utc=True)
    for col in ["open", "high", "low", "close", "volume"]:
        out[col] = pd.to_numeric(out.get(col), errors="coerce")
    if "symbol" not in out.columns:
        out["symbol"] = ""
    out = out.dropna(subset=["timestamp", "close"]).copy()
    if out.empty:
        return pd.DataFrame()
    out["volume"] = out["volume"].fillna(0.0)
    out["date_key"] = out["timestamp"].dt.date.astype(str)
    return out[["timestamp", "symbol", "open", "high", "low", "close", "volume", "date_key"]].sort_values("timestamp")


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def get_databento_client() -> Any | None:
    if not FETCH_MISSING:
        return None
    load_env_file(ROOT / ".env.local")
    load_env_file(ROOT / ".dev.vars")
    key = os.environ.get("DATABENTO_API_KEY")
    if not key:
        return None
    try:
        import databento as db  # type: ignore
    except Exception:
        return None
    return db.Historical(key=key)


def fetch_anchor_window(client: Any, symbol: str, date_key: str) -> pd.DataFrame:
    start = pd.Timestamp(date_key, tz="UTC") + pd.Timedelta(hours=19, minutes=30)
    end = pd.Timestamp(date_key, tz="UTC") + pd.Timedelta(days=1, hours=1, minutes=30)
    data = client.timeseries.get_range(
        dataset=DATASET,
        schema="ohlcv-1m",
        symbols=[symbol],
        stype_in="raw_symbol",
        start=start.isoformat(),
        end=end.isoformat(),
    )
    df = data.to_df()
    if df is None or df.empty:
        return pd.DataFrame()
    return df.reset_index()


def cache_file_index() -> dict[tuple[str, str], list[Path]]:
    dirs = [V126_CACHE_CTC, V127_CACHE_EXTRA]
    index: dict[tuple[str, str], list[Path]] = {}
    patterns = [
        re.compile(r"ohlcv_1m_ctc_(?P<symbol>GC[A-Z0-9]+)_(?P<date>\d{4}-\d{2}-\d{2})_"),
        re.compile(r"ohlcv_1m_\d+_(?P<symbol>GC[A-Z0-9]+)_(?P<date>\d{4}-\d{2}-\d{2})\.csv"),
    ]
    for d in dirs:
        if not d.exists():
            continue
        for path in d.glob("*.csv"):
            for pat in patterns:
                m = pat.search(path.name)
                if not m:
                    continue
                key = (m.group("symbol"), m.group("date"))
                index.setdefault(key, []).append(path)
                break
    return index


class MinuteStore:
    def __init__(self) -> None:
        V130_CACHE.mkdir(parents=True, exist_ok=True)
        self.index = cache_file_index()
        for path in V130_CACHE.glob("*.csv"):
            m = re.search(r"anchor_window_(?P<symbol>GC[A-Z0-9]+)_(?P<date>\d{4}-\d{2}-\d{2})\.csv", path.name)
            if m:
                self.index.setdefault((m.group("symbol"), m.group("date")), []).append(path)
        self.loaded: dict[tuple[str, str], pd.DataFrame] = {}
        self.client = get_databento_client()
        self.fetch_log: list[dict[str, Any]] = []

    def get(self, symbol: str, date_key: str) -> pd.DataFrame:
        key = (symbol, date_key)
        if key in self.loaded:
            return self.loaded[key]
        fetch_path = V130_CACHE / f"anchor_window_{symbol}_{date_key}.csv"
        if fetch_path.exists() and fetch_path not in self.index.get(key, []):
            self.index.setdefault(key, []).append(fetch_path)
        frames = [normalize_feed(p) for p in self.index.get(key, [])]
        frames = [f for f in frames if not f.empty]
        existing_rows = int(sum(len(f) for f in frames))
        if self.client is not None and not fetch_path.exists() and existing_rows < 60:
            status = "downloaded"
            error = ""
            rows = 0
            try:
                raw = fetch_anchor_window(self.client, symbol, date_key)
                raw.to_csv(fetch_path, index=False)
                normalized = normalize_feed(fetch_path)
                if not normalized.empty:
                    frames.append(normalized)
                rows = int(len(raw))
            except Exception as exc:
                status = "fetch_error"
                error = str(exc)[:500]
            self.fetch_log.append({"symbol": symbol, "date": date_key, "status": status, "rows": rows, "error": error})
        if not frames:
            self.loaded[key] = pd.DataFrame()
            return self.loaded[key]
        out = pd.concat(frames, ignore_index=True)
        out = out.sort_values("timestamp").drop_duplicates("timestamp")
        self.loaded[key] = out.reset_index(drop=True)
        return self.loaded[key]


def anchor_timestamp(date_key: str, anchor_minute: int) -> pd.Timestamp:
    base = pd.Timestamp(date_key, tz="UTC")
    # Official settlement-like windows observed in V1.27 can spill after UTC midnight.
    day_offset = 1 if anchor_minute < 4 * 60 else 0
    return base + pd.Timedelta(days=day_offset, minutes=int(anchor_minute))


def extract_anchor_price(feed: pd.DataFrame, date_key: str, spec: AnchorSpec) -> dict[str, Any]:
    if feed.empty:
        return {"price": math.nan, "volume": 0.0, "bars": 0, "minutes_away": math.nan, "status": "missing_feed"}
    target = anchor_timestamp(date_key, spec.anchor_minute_of_day)
    if spec.method == "nearest":
        tmp = feed.copy()
        tmp["minutes_away"] = (tmp["timestamp"] - target).abs().dt.total_seconds() / 60.0
        nearest = tmp.sort_values(["minutes_away", "timestamp"]).head(1)
        if nearest.empty:
            return {"price": math.nan, "volume": 0.0, "bars": 0, "minutes_away": math.nan, "status": "missing_bar"}
        minutes_away = float(nearest["minutes_away"].iloc[0])
        if minutes_away > spec.nearest_tolerance_minutes:
            return {
                "price": math.nan,
                "volume": 0.0,
                "bars": 0,
                "minutes_away": minutes_away,
                "status": "outside_tolerance",
            }
        return {
            "price": float(nearest["close"].iloc[0]),
            "volume": float(nearest["volume"].iloc[0]),
            "bars": 1,
            "minutes_away": minutes_away,
            "status": "matched",
        }

    if spec.method == "next_after":
        tmp = feed[(feed["timestamp"] >= target) & (feed["timestamp"] <= target + pd.Timedelta(minutes=spec.nearest_tolerance_minutes))].copy()
        if tmp.empty:
            return {
                "price": math.nan,
                "volume": 0.0,
                "bars": 0,
                "minutes_away": math.nan,
                "status": "no_trade_after_anchor",
            }
        first = tmp.sort_values("timestamp").head(1)
        minutes_away = float((first["timestamp"].iloc[0] - target).total_seconds() / 60.0)
        return {
            "price": float(first["close"].iloc[0]),
            "volume": float(first["volume"].iloc[0]),
            "bars": 1,
            "minutes_away": minutes_away,
            "status": "matched",
        }

    half = pd.Timedelta(minutes=spec.window_minutes / 2.0)
    window = feed[(feed["timestamp"] >= target - half) & (feed["timestamp"] <= target + half)].copy()
    if window.empty:
        return {"price": math.nan, "volume": 0.0, "bars": 0, "minutes_away": math.nan, "status": "missing_window"}
    volume = pd.to_numeric(window["volume"], errors="coerce").fillna(0.0)
    close = pd.to_numeric(window["close"], errors="coerce")
    if volume.sum() > 0:
        price = float((close * volume).sum() / volume.sum())
    else:
        price = float(close.mean())
    minute_away = float((window["timestamp"] - target).abs().dt.total_seconds().min() / 60.0)
    return {
        "price": price,
        "volume": float(volume.sum()),
        "bars": int(len(window)),
        "minutes_away": minute_away,
        "status": "matched",
    }


def run_anchor(spec: AnchorSpec, trades: pd.DataFrame, store: MinuteStore) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for _, tr in trades.iterrows():
        entry_feed = store.get(str(tr["front_symbol"]), str(tr["date"]))
        exit_feed = store.get(str(tr["exit_symbol"]), str(tr["exit_date"]))
        entry = extract_anchor_price(entry_feed, str(tr["date"]), spec)
        exit_ = extract_anchor_price(exit_feed, str(tr["exit_date"]), spec)
        matched = entry["status"] == "matched" and exit_["status"] == "matched"
        notional = float(tr["notional_usd"]) * float(tr.get("position_multiplier", 1.0))
        fee_rate = float(tr["fee_rate"])
        anchor_return = math.nan
        anchor_pnl = math.nan
        anchor_pnl_2x_cost = math.nan
        if matched and entry["price"] and not math.isnan(entry["price"]):
            anchor_return = (float(exit_["price"]) - float(entry["price"])) / float(entry["price"])
            anchor_pnl = notional * anchor_return - notional * fee_rate
            anchor_pnl_2x_cost = notional * anchor_return - notional * fee_rate * 2.0
        rows.append(
            {
                "trade_id_v130": int(tr["trade_id_v130"]),
                "fold": tr["fold"],
                "split": tr["split"],
                "date": tr["date"],
                "exit_date": tr["exit_date"],
                "front_symbol": tr["front_symbol"],
                "exit_symbol": tr["exit_symbol"],
                "score": float(tr["score"]),
                "official_settlement_pnl": float(tr["official_settlement_pnl"]),
                "entry_settlement_price": float(tr["entry_settlement_price"]),
                "exit_settlement_price": float(tr["exit_settlement_price"]),
                "anchor_name": spec.name,
                "anchor_time_utc": spec.anchor_time_utc,
                "anchor_minute_of_day": spec.anchor_minute_of_day,
                "anchor_method": spec.method,
                "window_minutes": spec.window_minutes,
                "entry_anchor_price": entry["price"],
                "exit_anchor_price": exit_["price"],
                "entry_anchor_status": entry["status"],
                "exit_anchor_status": exit_["status"],
                "entry_anchor_bars": entry["bars"],
                "exit_anchor_bars": exit_["bars"],
                "entry_anchor_volume": entry["volume"],
                "exit_anchor_volume": exit_["volume"],
                "entry_minutes_away": entry["minutes_away"],
                "exit_minutes_away": exit_["minutes_away"],
                "matched": bool(matched),
                "anchor_return": anchor_return,
                "anchor_pnl": anchor_pnl,
                "anchor_pnl_2x_cost": anchor_pnl_2x_cost,
                "pnl_delta_vs_official": anchor_pnl - float(tr["official_settlement_pnl"]) if matched else math.nan,
                "entry_abs_diff_vs_settlement": abs(float(entry["price"]) - float(tr["entry_settlement_price"])) if matched else math.nan,
                "exit_abs_diff_vs_settlement": abs(float(exit_["price"]) - float(tr["exit_settlement_price"])) if matched else math.nan,
            }
        )
    return pd.DataFrame(rows)


def audit_anchor(df: pd.DataFrame, trades_total: int) -> dict[str, Any]:
    matched = df[df["matched"]].copy()
    coverage = float(len(matched) / trades_total) if trades_total else 0.0
    out: dict[str, Any] = {
        "anchor_name": str(df["anchor_name"].iloc[0]) if not df.empty else "",
        "anchor_time_utc": str(df["anchor_time_utc"].iloc[0]) if not df.empty else "",
        "anchor_method": str(df["anchor_method"].iloc[0]) if not df.empty else "",
        "window_minutes": int(df["window_minutes"].iloc[0]) if not df.empty else 0,
        "matched_trades": int(len(matched)),
        "total_trades": int(trades_total),
        "coverage_rate": coverage,
    }
    if matched.empty:
        out.update(
            {
                "pnl_corr": 0.0,
                "sign_match": 0.0,
                "mean_abs_pnl_diff": 999.0,
                "median_abs_pnl_diff": 999.0,
                "mean_abs_entry_price_diff": 999.0,
                "mean_abs_exit_price_diff": 999.0,
                "metrics": metrics([]),
                "metrics_2x_cost": metrics([]),
            }
        )
        return out
    diff = pd.to_numeric(matched["pnl_delta_vs_official"], errors="coerce")
    out.update(
        {
            "pnl_corr": safe_corr(matched["official_settlement_pnl"], matched["anchor_pnl"]),
            "sign_match": sign_match(matched["official_settlement_pnl"], matched["anchor_pnl"]),
            "mean_abs_pnl_diff": float(diff.abs().mean()),
            "median_abs_pnl_diff": float(diff.abs().median()),
            "mean_abs_entry_price_diff": float(pd.to_numeric(matched["entry_abs_diff_vs_settlement"], errors="coerce").abs().mean()),
            "mean_abs_exit_price_diff": float(pd.to_numeric(matched["exit_abs_diff_vs_settlement"], errors="coerce").abs().mean()),
            "mean_entry_minutes_away": float(pd.to_numeric(matched["entry_minutes_away"], errors="coerce").mean()),
            "mean_exit_minutes_away": float(pd.to_numeric(matched["exit_minutes_away"], errors="coerce").mean()),
            "metrics": metrics(pd.to_numeric(matched["anchor_pnl"], errors="coerce").fillna(0.0).tolist()),
            "metrics_2x_cost": metrics(pd.to_numeric(matched["anchor_pnl_2x_cost"], errors="coerce").fillna(0.0).tolist()),
        }
    )
    for split in ["rolling", "holdout"]:
        sub = matched[matched["split"] == split]
        out[f"{split}_matched"] = int(len(sub))
        out[f"{split}_pnl_corr"] = safe_corr(sub["official_settlement_pnl"], sub["anchor_pnl"]) if len(sub) >= 3 else 0.0
        out[f"{split}_sign_match"] = sign_match(sub["official_settlement_pnl"], sub["anchor_pnl"]) if len(sub) else 0.0
        out[f"{split}_net_pnl"] = float(pd.to_numeric(sub["anchor_pnl"], errors="coerce").fillna(0.0).sum())
        out[f"{split}_official_net_pnl"] = float(pd.to_numeric(sub["official_settlement_pnl"], errors="coerce").fillna(0.0).sum())
    return out


def flatten_audit(audit: dict[str, Any]) -> dict[str, Any]:
    row = {k: v for k, v in audit.items() if not isinstance(v, dict)}
    for prefix in ["metrics", "metrics_2x_cost"]:
        for k, v in audit.get(prefix, {}).items():
            row[f"{prefix}_{k}"] = v
    return row


def select_best(candidates: list[dict[str, Any]]) -> tuple[dict[str, Any], str]:
    rows = [flatten_audit(c) for c in candidates]
    if not rows:
        return {}, "no_anchor_candidates"
    df = pd.DataFrame(rows)
    df["selection_score"] = (
        df["coverage_rate"].fillna(0) * 120
        + df["pnl_corr"].fillna(0) * 35
        + df["sign_match"].fillna(0) * 25
        - df["mean_abs_pnl_diff"].fillna(999) * 0.25
        + np.minimum(df["metrics_net_pnl_usd"].fillna(0), 2500) * 0.01
    )
    df = df.sort_values(["selection_score", "coverage_rate", "pnl_corr"], ascending=False)
    best = df.iloc[0].to_dict()
    strict = (
        best["coverage_rate"] >= 0.80
        and best["pnl_corr"] >= 0.85
        and best["sign_match"] >= 0.80
        and best["metrics_net_pnl_usd"] > 0
        and best["rolling_net_pnl"] > 0
        and best["holdout_net_pnl"] > 0
        and best["mean_abs_pnl_diff"] <= 45.0
    )
    if strict:
        return best, "tradable_execution_anchor_candidate"
    if best["coverage_rate"] >= 0.70 and best["pnl_corr"] >= 0.75 and best["metrics_net_pnl_usd"] > 0:
        return best, "execution_anchor_watchlist"
    return best, "no_tradable_anchor_yet"


def write_report(summary: dict[str, Any], best_trades: pd.DataFrame, candidates: pd.DataFrame) -> None:
    best = summary["best_anchor"]
    lines = [
        f"# {VERSION}",
        "",
        "## 定位",
        "",
        "V1.30 只验证可交易执行锚，不调 Q 动态退出、不调 trailing、不优化新交易信号。",
        "目标是把 V1.29 official-settlement baseline 转成真实交易前可定义的分钟/VWAP 锚点。",
        "",
        "## 结论",
        "",
        f"- 状态：`{summary['status']}`",
        f"- 最佳锚：`{best.get('anchor_name')}`，UTC `{best.get('anchor_time_utc')}`，方法 `{best.get('anchor_method')}`，窗口 `{best.get('window_minutes')}` 分钟",
        f"- 覆盖率：{best.get('coverage_rate', 0):.2%}（{int(best.get('matched_trades', 0))}/{int(best.get('total_trades', 0))}）",
        f"- PnL 相关：{best.get('pnl_corr', 0):.3f}",
        f"- 方向一致率：{best.get('sign_match', 0):.2%}",
        f"- 平均单笔 PnL 偏差：${best.get('mean_abs_pnl_diff', 0):.2f}",
        f"- 锚点净收益：${best.get('metrics_net_pnl_usd', 0):.2f}，PF {best.get('metrics_profit_factor', 0):.3f}",
        f"- 2x 成本压力净收益：${best.get('metrics_2x_cost_net_pnl_usd', 0):.2f}，PF {best.get('metrics_2x_cost_profit_factor', 0):.3f}",
        "",
        "## 执行解释",
        "",
        "这个锚点是固定时间/固定窗口的执行价代理，交易前即可定义；它不是事后 settlement 价格，也不是 Q/trailing 出场调参。",
        "如果覆盖率、PnL 相关、方向一致率和双倍成本压力都过线，下一步才允许把它作为 V1.31 执行层基线。",
        "",
        "## 主要风险",
        "",
        "- 当前分钟缓存来自既有 Databento 下载窗口，未覆盖所有可能交易日；低覆盖锚点不能晋级。",
        "- VWAP 窗口能代表可执行意图，但还不是真实逐笔成交模拟；后续仍需 bid/ask 或 MBP 深度验证。",
        "- 在这个锚未稳定前，继续调 Q 动态退出和 trailing 没有统计意义。",
        "",
        "## 输出文件",
        "",
        "- `hfcd_trading_v1_30_anchor_candidates.csv`",
        "- `hfcd_trading_v1_30_best_anchor_trades.csv`",
        "- `hfcd_trading_v1_30_summary.json`",
        "- `HFCD_Trading_V1_30_GoldTradableExecutionAnchor.png`",
    ]
    (OUT_DIR / "HFCD_Trading_V1_30_GoldTradableExecutionAnchor.md").write_text("\n".join(lines), encoding="utf-8")

    if candidates.empty:
        return
    plot_df = candidates.sort_values("selection_score", ascending=False).head(10).copy()
    fig, axes = plt.subplots(2, 2, figsize=(13, 8))
    axes = axes.flatten()
    axes[0].barh(plot_df["anchor_name"], plot_df["coverage_rate"], color="#1f77b4")
    axes[0].set_title("Coverage")
    axes[0].invert_yaxis()
    axes[1].barh(plot_df["anchor_name"], plot_df["pnl_corr"], color="#2ca02c")
    axes[1].set_title("PnL Corr vs Official")
    axes[1].invert_yaxis()
    axes[2].barh(plot_df["anchor_name"], plot_df["mean_abs_pnl_diff"], color="#ff7f0e")
    axes[2].set_title("Mean Abs PnL Diff")
    axes[2].invert_yaxis()
    axes[3].barh(plot_df["anchor_name"], plot_df["metrics_net_pnl_usd"], color="#9467bd")
    axes[3].set_title("Anchor Net PnL")
    axes[3].invert_yaxis()
    fig.tight_layout()
    fig.savefig(OUT_DIR / "HFCD_Trading_V1_30_GoldTradableExecutionAnchor.png", dpi=180)
    plt.close(fig)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    trades = load_selected_trades()
    specs = build_anchor_specs()
    store = MinuteStore()

    all_candidate_rows: list[dict[str, Any]] = []
    all_audits: list[dict[str, Any]] = []
    best_trade_frame = pd.DataFrame()
    anchor_frames: dict[str, pd.DataFrame] = {}

    for spec in specs:
        frame = run_anchor(spec, trades, store)
        audit = audit_anchor(frame, len(trades))
        flat = flatten_audit(audit)
        all_audits.append(audit)
        all_candidate_rows.append(flat)
        anchor_frames[spec.name] = frame

    candidates_df = pd.DataFrame(all_candidate_rows)
    if not candidates_df.empty:
        candidates_df["selection_score"] = (
            candidates_df["coverage_rate"].fillna(0) * 120
            + candidates_df["pnl_corr"].fillna(0) * 35
            + candidates_df["sign_match"].fillna(0) * 25
            - candidates_df["mean_abs_pnl_diff"].fillna(999) * 0.25
            + np.minimum(candidates_df["metrics_net_pnl_usd"].fillna(0), 2500) * 0.01
        )
        candidates_df = candidates_df.sort_values("selection_score", ascending=False).reset_index(drop=True)

    best, status = select_best(all_audits)
    if best:
        best_name = str(best["anchor_name"])
        best_trade_frame = anchor_frames.get(best_name, pd.DataFrame()).copy()
        if not best_trade_frame.empty:
            best_trade_frame = best_trade_frame.sort_values(["date", "fold"]).reset_index(drop=True)

    coverage_status = "cache_available" if store.index else "no_minute_cache"
    summary = {
        "version": VERSION,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "status": status,
        "minute_cache_status": coverage_status,
        "minute_cache_index_keys": len(store.index),
        "selected_v129_trade_count": int(len(trades)),
        "anchor_specs_tested": int(len(specs)),
        "best_anchor": best,
        "official_baseline_metrics": metrics(pd.to_numeric(trades["official_settlement_pnl"], errors="coerce").fillna(0.0).tolist()),
        "gate": {
            "candidate_requires": {
                "coverage_rate": ">= 0.80",
                "pnl_corr": ">= 0.85",
                "sign_match": ">= 0.80",
                "net_pnl": "> 0",
                "rolling_and_holdout_net_pnl": "> 0",
                "mean_abs_pnl_diff_usd": "<= 45",
            },
            "passed": status == "tradable_execution_anchor_candidate",
        },
    }

    candidates_df.to_csv(OUT_DIR / "hfcd_trading_v1_30_anchor_candidates.csv", index=False)
    if not best_trade_frame.empty:
        best_trade_frame.to_csv(OUT_DIR / "hfcd_trading_v1_30_best_anchor_trades.csv", index=False)
        coverage = (
            best_trade_frame.groupby(["entry_anchor_status", "exit_anchor_status", "matched"], dropna=False)
            .size()
            .reset_index(name="count")
        )
        coverage.to_csv(OUT_DIR / "hfcd_trading_v1_30_anchor_coverage_audit.csv", index=False)
    else:
        (OUT_DIR / "hfcd_trading_v1_30_best_anchor_trades.csv").write_text("", encoding="utf-8")
        (OUT_DIR / "hfcd_trading_v1_30_anchor_coverage_audit.csv").write_text("", encoding="utf-8")
    write_csv(OUT_DIR / "hfcd_trading_v1_30_fetch_log.csv", store.fetch_log)

    with (OUT_DIR / "hfcd_trading_v1_30_summary.json").open("w", encoding="utf-8") as f:
        json.dump(json_clean(summary), f, ensure_ascii=False, indent=2)
    write_csv(OUT_DIR / "hfcd_trading_v1_30_summary.csv", [flatten_audit(best)] if best else [])
    write_report(summary, best_trade_frame, candidates_df)

    print(json.dumps(json_clean(summary), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
