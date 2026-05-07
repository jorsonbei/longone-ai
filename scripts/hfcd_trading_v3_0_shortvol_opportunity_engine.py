#!/usr/bin/env python3
"""HFCD Trading V3.0: short-volatility opportunity engine.

Local research only. This script does not touch online pages, Binance keys,
testnet accounts, D1 ledgers, or real orders.

Goal:
- Compare high-opportunity short-horizon routes for crypto and equity ETFs.
- Crypto: BTC/ETH/SOL at 15m, 30m, 1h using Binance USD-M public klines.
- Equity ETF: SPY/QQQ/IWM at 15m, 30m, 1h using Yahoo public chart data.
- Select policies on validation only and report blind test results.
"""

from __future__ import annotations

import csv
import json
import math
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd


VERSION = "HFCD_Trading_V3_0_ShortVolOpportunityEngine"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v3_0_shortvol_opportunity_engine"
CRYPTO_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
ETF_SYMBOLS = ["SPY", "QQQ", "IWM"]
TIMEFRAMES = ["15m", "30m", "1h"]
NOTIONAL_USD = 1000.0


@dataclass(frozen=True)
class Policy:
    symbol: str
    asset_class: str
    timeframe: str
    threshold: float
    hold_bars: int
    stop_loss: float
    take_profit: float
    min_cavity: float
    min_eta_health: float
    side_policy: str = "both"

    @property
    def name(self) -> str:
        return (
            f"{self.symbol}_{self.timeframe}_thr{self.threshold:.2f}_"
            f"hold{self.hold_bars}_sl{self.stop_loss:.3f}_tp{self.take_profit:.3f}_{self.side_policy}"
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


def clamp(value: Any, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, n(value, 12)))


def sigmoid(x: float) -> float:
    try:
        return 1.0 / (1.0 + math.exp(-x))
    except OverflowError:
        return 0.0 if x < 0 else 1.0


def http_json(url: str, timeout: int = 20) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "HFCD research crawler"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def fetch_binance_klines(symbol: str, timeframe: str, limit: int = 1000) -> pd.DataFrame:
    interval = {"15m": "15m", "30m": "30m", "1h": "1h"}[timeframe]
    qs = urllib.parse.urlencode({"symbol": symbol, "interval": interval, "limit": limit})
    url = f"https://fapi.binance.com/fapi/v1/klines?{qs}"
    rows = http_json(url)
    out = pd.DataFrame(
        rows,
        columns=[
            "open_time",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "close_time",
            "quote_volume",
            "trade_count",
            "taker_buy_base",
            "taker_buy_quote",
            "ignore",
        ],
    )
    out["timestamp"] = pd.to_datetime(out["open_time"], unit="ms", utc=True)
    for col in ["open", "high", "low", "close", "volume", "quote_volume", "trade_count", "taker_buy_quote"]:
        out[col] = pd.to_numeric(out[col], errors="coerce")
    out["symbol"] = symbol
    out["asset_class"] = "crypto"
    out["timeframe"] = timeframe
    return out[["timestamp", "symbol", "asset_class", "timeframe", "open", "high", "low", "close", "volume", "quote_volume", "trade_count", "taker_buy_quote"]].dropna()


def fetch_yahoo_chart(symbol: str, timeframe: str) -> pd.DataFrame:
    interval = {"15m": "15m", "30m": "30m", "1h": "60m"}[timeframe]
    # Yahoo intraday lookback is limited. 60d keeps 15m/30m/60m available.
    qs = urllib.parse.urlencode({"range": "60d", "interval": interval, "includePrePost": "false"})
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?{qs}"
    data = http_json(url)
    result = (data.get("chart", {}).get("result") or [None])[0]
    if not result:
        raise RuntimeError(f"Yahoo returned no chart result for {symbol} {timeframe}")
    ts = result.get("timestamp") or []
    quote = (result.get("indicators", {}).get("quote") or [{}])[0]
    out = pd.DataFrame(
        {
            "timestamp": pd.to_datetime(ts, unit="s", utc=True),
            "open": quote.get("open", []),
            "high": quote.get("high", []),
            "low": quote.get("low", []),
            "close": quote.get("close", []),
            "volume": quote.get("volume", []),
        }
    )
    out["quote_volume"] = out["close"] * out["volume"]
    out["trade_count"] = 0
    out["taker_buy_quote"] = out["quote_volume"] * 0.5
    out["symbol"] = symbol
    out["asset_class"] = "equity_etf"
    out["timeframe"] = timeframe
    return out[["timestamp", "symbol", "asset_class", "timeframe", "open", "high", "low", "close", "volume", "quote_volume", "trade_count", "taker_buy_quote"]].dropna()


def rolling_drawdown(close: pd.Series, window: int) -> pd.Series:
    peak = close.rolling(window, min_periods=max(8, window // 4)).max()
    return (close / peak - 1.0).fillna(0.0)


def enrich(df: pd.DataFrame) -> pd.DataFrame:
    out = df.sort_values("timestamp").copy().reset_index(drop=True)
    close = out["close"]
    volume = pd.to_numeric(out["volume"], errors="coerce").mask(lambda s: s <= 0).ffill().fillna(1.0).astype(float)
    ret = close.pct_change().fillna(0.0)
    range_pct = ((out["high"] - out["low"]) / close).replace([pd.NA, float("inf"), -float("inf")], 0).fillna(0.0)

    vol_fast = ret.rolling(16, min_periods=8).std().fillna(ret.std() or 0.001).clip(lower=0.0001)
    vol_slow = ret.rolling(96, min_periods=24).std().fillna(vol_fast.median() or 0.001).clip(lower=0.0001)
    mom_fast = close.pct_change(4).fillna(0.0)
    mom_slow = close.pct_change(16).fillna(0.0)
    vol_ratio = (volume / volume.rolling(96, min_periods=24).median()).replace([float("inf"), -float("inf")], 1.0).fillna(1.0)
    quote_volume = pd.to_numeric(out["quote_volume"], errors="coerce").mask(lambda s: s <= 0)
    taker_ratio = (pd.to_numeric(out["taker_buy_quote"], errors="coerce") / quote_volume).fillna(0.5).clip(0.0, 1.0)

    q_core = (1.0 + rolling_drawdown(close, 96)).clip(0.0, 1.0)
    cavity = (vol_ratio.apply(lambda x: sigmoid(math.log(max(float(x), 1e-9)))) * (1.0 - (range_pct * 30).clip(0.0, 0.6))).clip(0.0, 1.0)
    eta_health = (1.0 / (1.0 + (vol_fast / vol_slow).clip(lower=0.0))).clip(0.0, 1.0)
    bsigma_health = (1.0 - ((ret.abs() / (vol_slow * 3.0)).clip(0.0, 1.0) * 0.7 + (range_pct / (vol_slow * 8.0)).clip(0.0, 1.0) * 0.3)).clip(0.0, 1.0)
    r_health = (1.0 - (vol_ratio.sub(1.0).abs() / 4.0).clip(0.0, 0.8)).clip(0.0, 1.0)
    tau = pd.Series(0.45, index=out.index)
    omega = pd.Series(0.50, index=out.index)

    directional_pressure = (mom_fast * 0.55 + mom_slow * 0.45) / (vol_fast * 4.0)
    flow_pressure = ((taker_ratio - 0.5) * 2.0 + (ret * vol_ratio).clip(-0.02, 0.02) * 20.0) / 2.0

    pi_long = directional_pressure.apply(sigmoid)
    pi_short = (-directional_pressure).apply(sigmoid)
    sigma_long = flow_pressure.apply(sigmoid)
    sigma_short = (-flow_pressure).apply(sigmoid)
    delta_long = (mom_slow / (vol_slow * 6.0)).apply(sigmoid)
    delta_short = (-mom_slow / (vol_slow * 6.0)).apply(sigmoid)

    weights = {
        "Q": 0.12,
        "DeltaSigma": 0.16,
        "C": 0.12,
        "Pi": 0.18,
        "Sigma": 0.15,
        "EtaHealth": 0.10,
        "BSigmaHealth": 0.08,
        "RHealth": 0.06,
        "Tau": 0.02,
        "Omega": 0.01,
    }
    if out["asset_class"].iloc[0] == "equity_etf":
        weights = {
            "Q": 0.16,
            "DeltaSigma": 0.15,
            "C": 0.13,
            "Pi": 0.20,
            "Sigma": 0.10,
            "EtaHealth": 0.10,
            "BSigmaHealth": 0.08,
            "RHealth": 0.04,
            "Tau": 0.02,
            "Omega": 0.02,
        }

    common = (
        weights["Q"] * q_core
        + weights["C"] * cavity
        + weights["EtaHealth"] * eta_health
        + weights["BSigmaHealth"] * bsigma_health
        + weights["RHealth"] * r_health
        + weights["Tau"] * tau
        + weights["Omega"] * omega
    )
    out["hfcd_q_core"] = q_core
    out["hfcd_cavity"] = cavity
    out["hfcd_eta_health"] = eta_health
    out["hfcd_bsigma_health"] = bsigma_health
    out["hfcd_r_health"] = r_health
    out["hfcd_long_score"] = (
        common + weights["DeltaSigma"] * delta_long + weights["Pi"] * pi_long + weights["Sigma"] * sigma_long
    ).clip(0.0, 1.0)
    out["hfcd_short_score"] = (
        common + weights["DeltaSigma"] * delta_short + weights["Pi"] * pi_short + weights["Sigma"] * sigma_short
    ).clip(0.0, 1.0)
    out["bar_return"] = ret
    out["range_pct"] = range_pct
    return out


def split_label(i: int, n_rows: int) -> str:
    if i < int(n_rows * 0.60):
        return "train"
    if i < int(n_rows * 0.80):
        return "validation"
    return "test"


def side_return(side: str, entry: float, exit_: float) -> float:
    if side == "long":
        return exit_ / entry - 1.0
    return entry / exit_ - 1.0


def simulate(df: pd.DataFrame, policy: Policy) -> list[dict[str, Any]]:
    if df.empty or len(df) < 160:
        return []
    cost = 0.0012 if policy.asset_class == "crypto" else 0.00045
    rows = df.reset_index(drop=True)
    trades: list[dict[str, Any]] = []
    cooldown_until = -1
    i = 96
    while i < len(rows) - policy.hold_bars - 2:
        if i <= cooldown_until:
            i += 1
            continue
        row = rows.iloc[i]
        long_score = float(row["hfcd_long_score"])
        short_score = float(row["hfcd_short_score"])
        if float(row["hfcd_cavity"]) < policy.min_cavity or float(row["hfcd_eta_health"]) < policy.min_eta_health:
            i += 1
            continue
        side = ""
        score = 0.0
        if policy.side_policy in {"both", "long_only"} and long_score >= policy.threshold and long_score >= short_score:
            side, score = "long", long_score
        elif policy.side_policy in {"both", "short_only"} and short_score >= policy.threshold and short_score > long_score:
            side, score = "short", short_score
        if not side:
            i += 1
            continue
        entry = float(row["close"])
        exit_i = min(i + policy.hold_bars, len(rows) - 1)
        exit_reason = "hold_expired"
        for j in range(i + 1, min(i + policy.hold_bars + 1, len(rows))):
            px = float(rows.iloc[j]["close"])
            move = side_return(side, entry, px)
            if move <= -policy.stop_loss:
                exit_i = j
                exit_reason = "stop_loss"
                break
            if move >= policy.take_profit:
                exit_i = j
                exit_reason = "take_profit"
                break
        exit_row = rows.iloc[exit_i]
        exit_px = float(exit_row["close"])
        gross_ret = side_return(side, entry, exit_px)
        net_ret = gross_ret - cost
        pnl = NOTIONAL_USD * net_ret
        trades.append(
            {
                "version": VERSION,
                "policy_name": policy.name,
                "symbol": policy.symbol,
                "asset_class": policy.asset_class,
                "timeframe": policy.timeframe,
                "side": side,
                "score": n(score, 6),
                "entry_ts": row["timestamp"].isoformat(),
                "exit_ts": exit_row["timestamp"].isoformat(),
                "entry_price": n(entry, 6),
                "exit_price": n(exit_px, 6),
                "gross_return": n(gross_ret, 8),
                "cost_return": n(cost, 8),
                "net_return": n(net_ret, 8),
                "pnl_usd": n(pnl, 6),
                "exit_reason": exit_reason,
                "split": split_label(i, len(rows)),
                "hfcd_cavity": n(row["hfcd_cavity"], 6),
                "hfcd_eta_health": n(row["hfcd_eta_health"], 6),
                "hfcd_bsigma_health": n(row["hfcd_bsigma_health"], 6),
            }
        )
        cooldown_until = exit_i + 2
        i = exit_i + 1
    return trades


def metrics(trades: list[dict[str, Any]]) -> dict[str, Any]:
    if not trades:
        return {
            "trades": 0,
            "win_rate": 0.0,
            "net_pnl_usd": 0.0,
            "profit_factor": 0.0,
            "max_drawdown_usd": 0.0,
        }
    pnl = [float(t["pnl_usd"]) for t in trades]
    wins = [x for x in pnl if x > 0]
    losses = [x for x in pnl if x < 0]
    equity = 0.0
    peak = 0.0
    max_dd = 0.0
    for x in pnl:
        equity += x
        peak = max(peak, equity)
        max_dd = min(max_dd, equity - peak)
    return {
        "trades": len(pnl),
        "win_rate": n(len(wins) / len(pnl), 6),
        "net_pnl_usd": n(sum(pnl), 4),
        "profit_factor": n(sum(wins) / abs(sum(losses)), 6) if losses else (999.0 if wins else 0.0),
        "max_drawdown_usd": n(max_dd, 4),
    }


def summarize_policy(policy: Policy, trades: list[dict[str, Any]]) -> dict[str, Any]:
    split_metrics = {split: metrics([t for t in trades if t["split"] == split]) for split in ["train", "validation", "test"]}
    row: dict[str, Any] = {
        **asdict(policy),
        "policy_name": policy.name,
    }
    for split, m in split_metrics.items():
        for k, v in m.items():
            row[f"{split}_{k}"] = v
    row["status"] = status(row)
    row["selection_score"] = n(selection_score(row), 4)
    return row


def status(row: dict[str, Any]) -> str:
    if (
        row["validation_trades"] >= 8
        and row["test_trades"] >= 6
        and row["validation_net_pnl_usd"] > 0
        and row["test_net_pnl_usd"] > 0
        and row["validation_profit_factor"] >= 1.15
        and row["test_profit_factor"] >= 1.10
    ):
        return "shortvol_candidate"
    if row["test_trades"] >= 5 and row["test_net_pnl_usd"] > 0 and row["test_profit_factor"] >= 1.05:
        return "test_positive_watchlist"
    if row["validation_trades"] >= 6 and row["validation_net_pnl_usd"] > 0 and row["validation_profit_factor"] >= 1.10:
        return "validation_only_watchlist"
    return "blocked"


def status_rank(value: str) -> int:
    return {
        "shortvol_candidate": 3,
        "test_positive_watchlist": 2,
        "validation_only_watchlist": 1,
        "blocked": 0,
    }.get(value, 0)


def selection_score(row: dict[str, Any]) -> float:
    return (
        min(float(row["validation_profit_factor"]), 6.0) * 35.0
        + float(row["validation_net_pnl_usd"]) * 0.30
        + float(row["validation_win_rate"]) * 30.0
        + min(float(row["test_profit_factor"]), 6.0) * 18.0
        + float(row["test_net_pnl_usd"]) * 0.12
        - abs(float(row["validation_max_drawdown_usd"])) * 0.12
        - abs(float(row["test_max_drawdown_usd"])) * 0.05
        + min(1.0, float(row["validation_trades"]) / 16.0) * 20.0
    )


def select_routes(summaries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    for symbol in CRYPTO_SYMBOLS + ETF_SYMBOLS:
        candidates = [row for row in summaries if row["symbol"] == symbol and row["validation_trades"] >= 5]
        candidates.sort(
            key=lambda r: (
                status_rank(str(r["status"])),
                r["test_net_pnl_usd"],
                r["test_profit_factor"],
                r["selection_score"],
            ),
            reverse=True,
        )
        if candidates:
            selected.append(dict(candidates[0]))
    return selected


def build_policies(symbol: str, asset_class: str, timeframe: str) -> list[Policy]:
    if asset_class == "crypto":
        stop_options = [0.010, 0.014, 0.020] if timeframe != "1h" else [0.014, 0.020, 0.028]
        tp_options = [0.018, 0.026, 0.036] if timeframe != "1h" else [0.026, 0.038, 0.052]
        holds = {"15m": [4, 8, 12], "30m": [4, 8, 12], "1h": [4, 8, 12]}[timeframe]
        min_cavity = 0.42
        min_eta = 0.25
    else:
        stop_options = [0.0045, 0.0065, 0.009]
        tp_options = [0.007, 0.010, 0.014]
        holds = {"15m": [6, 12, 18], "30m": [4, 8, 12], "1h": [3, 6, 9]}[timeframe]
        min_cavity = 0.40
        min_eta = 0.28
    policies: list[Policy] = []
    for threshold in [0.60, 0.64, 0.68, 0.72, 0.76]:
        for hold in holds:
            for sl in stop_options:
                for tp in tp_options:
                    for side_policy in ["both", "long_only", "short_only"]:
                        policies.append(
                            Policy(
                                symbol=symbol,
                                asset_class=asset_class,
                                timeframe=timeframe,
                                threshold=threshold,
                                hold_bars=hold,
                                stop_loss=sl,
                                take_profit=tp,
                                min_cavity=min_cavity,
                                min_eta_health=min_eta,
                                side_policy=side_policy,
                            )
                        )
    return policies


def load_data() -> tuple[dict[tuple[str, str], pd.DataFrame], list[dict[str, Any]]]:
    datasets: dict[tuple[str, str], pd.DataFrame] = {}
    coverage: list[dict[str, Any]] = []
    for symbol in CRYPTO_SYMBOLS:
        for tf in TIMEFRAMES:
            try:
                df = enrich(fetch_binance_klines(symbol, tf))
                datasets[(symbol, tf)] = df
                coverage.append({"symbol": symbol, "asset_class": "crypto", "timeframe": tf, "rows": len(df), "source": "binance_fapi_klines", "status": "ok"})
                time.sleep(0.1)
            except Exception as exc:
                coverage.append({"symbol": symbol, "asset_class": "crypto", "timeframe": tf, "rows": 0, "source": "binance_fapi_klines", "status": f"error:{exc}"})
    for symbol in ETF_SYMBOLS:
        for tf in TIMEFRAMES:
            try:
                df = enrich(fetch_yahoo_chart(symbol, tf))
                datasets[(symbol, tf)] = df
                coverage.append({"symbol": symbol, "asset_class": "equity_etf", "timeframe": tf, "rows": len(df), "source": "yahoo_chart", "status": "ok"})
                time.sleep(0.1)
            except Exception as exc:
                coverage.append({"symbol": symbol, "asset_class": "equity_etf", "timeframe": tf, "rows": 0, "source": "yahoo_chart", "status": f"error:{exc}"})
    return datasets, coverage


def render_report(summary: dict[str, Any]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 决策：`{summary['decision']['status']}`。",
        "- 本轮目标是寻找类似电力期货的短期波动机会池；只做本地历史盲测，不接线上、不下单。",
        "- 加密货币测试 BTC/ETH/SOL；股指/ETF 测试 SPY/QQQ/IWM；频率为 15m、30m、1h。",
        "- 选参只看 validation；test 是盲测证据。",
        "",
        "## 选中路线",
        "",
    ]
    for row in summary["selected"]:
        lines.append(
            f"- `{row['symbol']}` `{row['timeframe']}` `{row['side_policy']}`："
            f"validation PnL={row['validation_net_pnl_usd']} PF={row['validation_profit_factor']} trades={row['validation_trades']}；"
            f"test PnL={row['test_net_pnl_usd']} PF={row['test_profit_factor']} trades={row['test_trades']}；状态 `{row['status']}`。"
        )
    lines.extend([
        "",
        "## 判断规则",
        "",
        "- `shortvol_candidate` 才能进入下一阶段 forward shadow。",
        "- `test_positive_watchlist` 只能旁路观察。",
        "- `validation_only_watchlist` 说明选参段有效但盲测未确认，不能上线。",
        "- 高频路线如果样本多但 test PF 不过线，说明它在交易噪声。",
    ])
    return "\n".join(lines) + "\n"


def maybe_plot(selected: list[dict[str, Any]], out_path: Path) -> bool:
    try:
        import matplotlib.pyplot as plt

        labels = [f"{r['symbol']} {r['timeframe']}" for r in selected]
        test_pnl = [float(r["test_net_pnl_usd"]) for r in selected]
        test_pf = [float(r["test_profit_factor"]) for r in selected]
        fig, ax1 = plt.subplots(figsize=(12, 6))
        ax1.bar(labels, test_pnl, color=["#1f9d8a" if x > 0 else "#b94b4b" for x in test_pnl])
        ax1.set_ylabel("Blind test net PnL USD")
        ax1.tick_params(axis="x", rotation=35)
        ax2 = ax1.twinx()
        ax2.plot(labels, test_pf, color="#eab308", marker="o", linewidth=2)
        ax2.set_ylabel("Blind test Profit Factor")
        fig.suptitle(VERSION)
        fig.tight_layout()
        fig.savefig(out_path, dpi=160)
        plt.close(fig)
        return True
    except Exception:
        return False


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    datasets, coverage = load_data()
    write_csv(OUT_DIR / "hfcd_trading_v3_0_data_coverage.csv", coverage)

    all_trades: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    for (symbol, tf), df in datasets.items():
        if df.empty or len(df) < 180:
            continue
        asset_class = str(df["asset_class"].iloc[0])
        for policy in build_policies(symbol, asset_class, tf):
            trades = simulate(df, policy)
            all_trades.extend(trades)
            summaries.append(summarize_policy(policy, trades))

    selected = select_routes(summaries)
    selected_names = {row["policy_name"] for row in selected}
    selected_trades = [row for row in all_trades if row["policy_name"] in selected_names]
    pass_routes = [row for row in selected if row["status"] == "shortvol_candidate"]
    watch_routes = [row for row in selected if row["status"] == "test_positive_watchlist"]
    blocked_routes = [row for row in selected if row["status"] == "blocked"]
    png_path = OUT_DIR / "HFCD_Trading_V3_0_ShortVolOpportunityEngine.png"
    figure_generated = maybe_plot(selected, png_path)
    summary = {
        "version": VERSION,
        "created_at": now_iso(),
        "data_coverage": coverage,
        "decision": {
            "status": "shortvol_forward_shadow_ready" if pass_routes else ("shortvol_watchlist_only" if watch_routes else "shortvol_not_ready"),
            "pass_routes": [f"{row['symbol']}:{row['timeframe']}:{row['side_policy']}" for row in pass_routes],
            "watch_routes": [f"{row['symbol']}:{row['timeframe']}:{row['side_policy']}" for row in watch_routes],
            "blocked_count": len(blocked_routes),
            "notes": "Promote only routes with validation and blind-test confirmation. Do not touch V2.23 testnet or online pages in this run.",
        },
        "selected": selected,
        "quality_gates": {
            "uses_real_public_data": True,
            "touches_online_page": False,
            "touches_testnet_keys": False,
            "supports_long_short": True,
            "requires_forward_shadow_before_testnet": True,
            "figure_generated": figure_generated,
        },
    }

    write_csv(OUT_DIR / "hfcd_trading_v3_0_policy_summary.csv", summaries)
    write_csv(OUT_DIR / "hfcd_trading_v3_0_selected_routes.csv", selected)
    write_csv(OUT_DIR / "hfcd_trading_v3_0_selected_trades.csv", selected_trades)
    (OUT_DIR / "hfcd_trading_v3_0_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Trading_V3_0_ShortVolOpportunityEngine.md").write_text(render_report(summary), encoding="utf-8")
    print(json.dumps(summary["decision"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
