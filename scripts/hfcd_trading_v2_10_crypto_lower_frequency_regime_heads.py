#!/usr/bin/env python3
"""HFCD Trading V2.10: BTC/ETH lower-frequency regime heads.

V2.8 showed that 5m BTC/ETH trading overtrades and fails OOS even with L2,
metrics and stablecoin sensors. V2.9 showed the only positive diagnostic slice
was a very low-frequency daily-top throttled sample.

This script builds a local-only 1h/4h regime-head replay. It keeps the same
60-day sensor window from V2.7, aggregates Binance 5m OHLCV + L2 + metrics into
1h and 4h bars, then selects parameters on validation before reporting test.
No online UI/page is changed.
"""

from __future__ import annotations

import csv
import json
import math
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd


VERSION = "HFCD_Trading_V2_10_CryptoLowerFrequencyRegimeHeads"
ROOT = Path.cwd()
V27_DIR = ROOT / "outputs" / "hfcd_trading_v2_7_crypto_extended_l2_sensor_audit"
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v2_10_crypto_lower_frequency_regime_heads"
SYMBOLS = ["BTCUSDT", "ETHUSDT"]
NOTIONAL_USD = 1000.0
ROUNDTRIP_COST = 0.0012


@dataclass(frozen=True)
class Policy:
    symbol: str
    timeframe: str
    head: str
    side_policy: str
    threshold: float
    hold_bars: int
    min_q: float
    min_cavity: float
    max_bsigma: float
    cooldown_bars: int
    stop_loss: float
    take_profit: float


def number(value: float, digits: int = 6) -> float:
    return round(float(value or 0.0), digits)


def clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


def to_float(value: Any) -> float:
    try:
        out = float(value)
        return out if math.isfinite(out) else 0.0
    except Exception:
        return 0.0


def fetch_json(url: str) -> Any:
    last = ""
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "HFCD-ThingNature-OS/2.10", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=35) as resp:
                return json.loads(resp.read().decode("utf-8", "ignore"))
        except Exception as exc:  # noqa: BLE001
            last = str(exc)
            time.sleep(0.45 + attempt * 0.35)
    raise RuntimeError(f"fetch failed: {url} :: {last}")


def iso_from_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat().replace("+00:00", "Z").replace(".000Z", "Z")


def fetch_klines(symbol: str, date_start: str, date_end: str) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    interval_ms = 5 * 60 * 1000
    cursor = int(datetime.fromisoformat(f"{date_start}T00:00:00+00:00").timestamp() * 1000)
    end = int(datetime.fromisoformat(f"{date_end}T23:59:59+00:00").timestamp() * 1000)
    while cursor <= end:
        params = urllib.parse.urlencode({
            "symbol": symbol,
            "interval": "5m",
            "limit": 1500,
            "startTime": cursor,
            "endTime": end,
        })
        payload = fetch_json(f"https://fapi.binance.com/fapi/v1/klines?{params}")
        if not isinstance(payload, list) or not payload:
            break
        for item in payload:
            rows.append({
                "timestamp": pd.Timestamp(iso_from_ms(int(item[0]))),
                "symbol": symbol,
                "open": to_float(item[1]),
                "high": to_float(item[2]),
                "low": to_float(item[3]),
                "close": to_float(item[4]),
                "volume": to_float(item[5]),
                "quote_volume": to_float(item[7]),
            })
        last_open = int(payload[-1][0])
        cursor = last_open + interval_ms
        if len(payload) < 1500:
            break
        time.sleep(0.08)
    df = pd.DataFrame(rows).drop_duplicates("timestamp").sort_values("timestamp")
    return df


def load_v27_window() -> tuple[str, str]:
    summary = json.loads((V27_DIR / "hfcd_trading_v2_7_summary.json").read_text(encoding="utf-8"))
    if "date_window" in summary:
        start = str(summary["date_window"]["start"])
        end = str(summary["date_window"]["end"])
    else:
        start = str(summary["date_start"])
        end = str(summary["date_end"])
    return start, end


def load_sensor_frame() -> pd.DataFrame:
    book = pd.read_csv(V27_DIR / "hfcd_trading_v2_7_book_depth_5m.csv")
    metrics = pd.read_csv(V27_DIR / "hfcd_trading_v2_7_metrics_5m.csv")
    stable = pd.read_csv(V27_DIR / "hfcd_trading_v2_7_stablecoin_supply_history.csv")
    for df in [book, metrics]:
        df["timestamp"] = pd.to_datetime(df["ts"], utc=True)
    stable["date"] = pd.to_datetime(stable["date"]).dt.strftime("%Y-%m-%d")
    stable_daily = stable.groupby("date", as_index=False).agg(
        stable_supply_usd=("supply_usd", "sum"),
        stable_change_1d_usd=("supply_change_1d_usd", "sum"),
        stable_change_7d_usd=("supply_change_7d_usd", "sum"),
    )
    stable_daily["stable_1d_z"] = (
        (stable_daily["stable_change_1d_usd"] - stable_daily["stable_change_1d_usd"].rolling(90, min_periods=7).mean())
        / stable_daily["stable_change_1d_usd"].rolling(90, min_periods=7).std().replace(0, pd.NA)
    ).fillna(0).clip(-4, 4)
    stable_daily["stable_7d_z"] = (
        (stable_daily["stable_change_7d_usd"] - stable_daily["stable_change_7d_usd"].rolling(90, min_periods=7).mean())
        / stable_daily["stable_change_7d_usd"].rolling(90, min_periods=7).std().replace(0, pd.NA)
    ).fillna(0).clip(-4, 4)

    merged = book.merge(metrics, on=["timestamp", "symbol"], how="outer", suffixes=("", "_metric"))
    merged["date"] = merged["timestamp"].dt.strftime("%Y-%m-%d")
    merged = merged.merge(stable_daily, on="date", how="left")
    return merged


def aggregate(symbol: str, timeframe: str, klines: pd.DataFrame, sensors: pd.DataFrame) -> pd.DataFrame:
    k = klines[klines["symbol"] == symbol].copy().set_index("timestamp")
    s = sensors[sensors["symbol"] == symbol].copy().set_index("timestamp")
    merged = k.join(s.drop(columns=["symbol", "ts", "date"], errors="ignore"), how="left")
    merged = merged.ffill()
    agg = merged.resample(timeframe, label="right", closed="right").agg({
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
        "volume": "sum",
        "quote_volume": "sum",
        "ask_0p2_notional": "mean",
        "bid_0p2_notional": "mean",
        "ask_1p0_notional": "mean",
        "bid_1p0_notional": "mean",
        "depth_imbalance_0p2": "mean",
        "depth_imbalance_1p0": "mean",
        "liquidity_cavity_0p2_usd": "mean",
        "liquidity_cavity_1p0_usd": "mean",
        "count_long_short_ratio": "mean",
        "count_toptrader_long_short_ratio": "mean",
        "sum_open_interest": "last",
        "stable_supply_usd": "last",
        "stable_change_1d_usd": "last",
        "stable_change_7d_usd": "last",
        "stable_1d_z": "last",
        "stable_7d_z": "last",
    }).dropna(subset=["open", "close"])
    agg["symbol"] = symbol
    agg["timeframe"] = timeframe
    return agg.reset_index()


def enrich_features(df: pd.DataFrame, btc_close: pd.Series | None = None) -> pd.DataFrame:
    out = df.copy()
    close = out["close"]
    out["ret_1"] = close.pct_change()
    out["ret_3"] = close.pct_change(3)
    out["ret_6"] = close.pct_change(6)
    out["ret_12"] = close.pct_change(12)
    out["vol_12"] = out["ret_1"].rolling(12, min_periods=4).std().fillna(0)
    out["vol_48"] = out["ret_1"].rolling(48, min_periods=12).std().fillna(out["vol_12"])
    out["eta"] = (out["vol_12"] / out["vol_48"].replace(0, pd.NA)).fillna(1).clip(0, 4)
    out["q_core"] = (1 - (close / close.rolling(48, min_periods=12).max() - 1).abs().clip(0, 0.12) / 0.12).fillna(0.55)
    out["q_core"] = out["q_core"].clip(0, 1)
    out["trend"] = (out["ret_3"] * 70 + out["ret_6"] * 45 + out["ret_12"] * 25).clip(-1.2, 1.2)
    out["trend_score"] = (out["trend"].abs() / 1.2).clip(0, 1)
    out["depth_usd"] = (out["ask_0p2_notional"].fillna(0) + out["bid_0p2_notional"].fillna(0)).clip(lower=0)
    depth_ref = out["depth_usd"].rolling(96, min_periods=12).quantile(0.75).replace(0, pd.NA)
    out["liquidity_cavity"] = (out["depth_usd"] / depth_ref).fillna(0.6).clip(0, 1.5) / 1.5
    out["oi_change"] = out["sum_open_interest"].pct_change(6).fillna(0).clip(-0.08, 0.08)
    out["lsr_pressure"] = ((out["count_long_short_ratio"].fillna(1) - 1).abs() + (out["count_toptrader_long_short_ratio"].fillna(1) - 1).abs()).clip(0, 2)
    out["b_sigma"] = (out["eta"] * 0.18 + out["lsr_pressure"] * 0.22 + out["oi_change"].abs() * 3).clip(0, 1)
    out["stable_score"] = ((out["stable_1d_z"].fillna(0) * 0.45 + out["stable_7d_z"].fillna(0) * 0.55) / 4 + 0.5).clip(0, 1)
    if btc_close is not None and out["symbol"].iloc[0] == "ETHUSDT":
        btc_aligned = btc_close.reindex(out["timestamp"]).ffill()
        rel = close.pct_change(6).fillna(0) - btc_aligned.pct_change(6).fillna(0).to_numpy()
        out["relative_btc_score"] = (rel * 80 + 0.5).clip(0, 1)
    else:
        out["relative_btc_score"] = 0.5
    return out.dropna(subset=["close"]).reset_index(drop=True)


def head_score(row: pd.Series, head: str) -> float:
    q = float(row["q_core"])
    c = float(row["liquidity_cavity"])
    trend = float(row["trend_score"])
    stable = float(row["stable_score"])
    b = float(row["b_sigma"])
    rel = float(row["relative_btc_score"])
    if head == "btc_macro_liquidity":
        return 0.25 * q + 0.25 * stable + 0.20 * c + 0.20 * trend + 0.10 * (1 - b)
    if head == "eth_beta_relative":
        return 0.18 * q + 0.18 * stable + 0.22 * c + 0.24 * trend + 0.10 * rel + 0.08 * (1 - b)
    return 0.22 * q + 0.20 * stable + 0.20 * c + 0.22 * trend + 0.16 * (1 - b)


def split_name(i: int, n: int) -> str:
    if i < int(n * 0.50):
        return "train"
    if i < int(n * 0.75):
        return "validation"
    return "test"


def simulate(df: pd.DataFrame, policy: Policy) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    cooldown_until = -1
    n = len(df)
    for i in range(60, n - policy.hold_bars - 2):
        if i < cooldown_until:
            continue
        row = df.iloc[i]
        score = head_score(row, policy.head)
        if score < policy.threshold:
            continue
        if row["q_core"] < policy.min_q or row["liquidity_cavity"] < policy.min_cavity or row["b_sigma"] > policy.max_bsigma:
            continue
        trend = float(row["trend"])
        side = "long" if trend >= 0 else "short"
        if policy.side_policy == "long_only" and side != "long":
            continue
        if policy.side_policy == "short_only" and side != "short":
            continue
        entry_idx = i + 1
        exit_idx = entry_idx + policy.hold_bars
        entry_price = float(df.iloc[entry_idx]["open"])
        exit_reason = "time_exit"
        exit_price = float(df.iloc[exit_idx]["close"])
        for j in range(entry_idx, exit_idx + 1):
            high = float(df.iloc[j]["high"])
            low = float(df.iloc[j]["low"])
            if side == "long":
                if (low - entry_price) / entry_price <= -policy.stop_loss:
                    exit_price = entry_price * (1 - policy.stop_loss)
                    exit_idx = j
                    exit_reason = "stop_loss"
                    break
                if (high - entry_price) / entry_price >= policy.take_profit:
                    exit_price = entry_price * (1 + policy.take_profit)
                    exit_idx = j
                    exit_reason = "take_profit"
                    break
            else:
                if (entry_price - high) / entry_price <= -policy.stop_loss:
                    exit_price = entry_price * (1 + policy.stop_loss)
                    exit_idx = j
                    exit_reason = "stop_loss"
                    break
                if (entry_price - low) / entry_price >= policy.take_profit:
                    exit_price = entry_price * (1 - policy.take_profit)
                    exit_idx = j
                    exit_reason = "take_profit"
                    break
        gross = (exit_price - entry_price) / entry_price if side == "long" else (entry_price - exit_price) / entry_price
        liquidity_discount = max(0.0, 0.55 - float(row["liquidity_cavity"])) * 0.00035
        net = gross - ROUNDTRIP_COST - liquidity_discount
        rows.append({
            "split": split_name(i, n),
            "symbol": policy.symbol,
            "timeframe": policy.timeframe,
            "head": policy.head,
            "side_policy": policy.side_policy,
            "side": side,
            "policy_name": policy_name(policy),
            "entry_ts": df.iloc[entry_idx]["timestamp"].isoformat().replace("+00:00", "Z"),
            "exit_ts": df.iloc[exit_idx]["timestamp"].isoformat().replace("+00:00", "Z"),
            "entry_price": number(entry_price, 8),
            "exit_price": number(exit_price, 8),
            "holding_bars": int(exit_idx - entry_idx),
            "score": number(score),
            "q_core": number(float(row["q_core"])),
            "liquidity_cavity": number(float(row["liquidity_cavity"])),
            "stable_score": number(float(row["stable_score"])),
            "b_sigma": number(float(row["b_sigma"])),
            "gross_return": number(gross, 8),
            "execution_cost": number(ROUNDTRIP_COST + liquidity_discount, 8),
            "net_return": number(net, 8),
            "pnl_usd": number(net * NOTIONAL_USD, 4),
            "exit_reason": exit_reason,
        })
        cooldown_until = exit_idx + policy.cooldown_bars
    return rows


def policy_name(policy: Policy) -> str:
    return f"{policy.symbol}_{policy.timeframe}_{policy.head}_{policy.side_policy}_t{policy.threshold}_h{policy.hold_bars}"


def metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    pnl = [float(r["pnl_usd"]) for r in rows]
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
        "trades": len(rows),
        "win_rate": number(len(wins) / len(rows), 6) if rows else 0.0,
        "net_pnl_usd": number(sum(pnl), 4),
        "profit_factor": number(sum(wins) / abs(sum(losses)), 6) if losses else (999.0 if wins else 0.0),
        "max_drawdown_usd": number(max_dd, 4),
        "avg_pnl_usd": number(sum(pnl) / len(rows), 4) if rows else 0.0,
    }


def summarize(policy: Policy, trades: list[dict[str, Any]]) -> dict[str, Any]:
    out = asdict(policy)
    out["policy_name"] = policy_name(policy)
    for split in ["train", "validation", "test"]:
        m = metrics([t for t in trades if t["split"] == split])
        for key, value in m.items():
            out[f"{split}_{key}"] = value
    out["selection_score"] = (
        out["validation_net_pnl_usd"] * 0.45
        + out["validation_profit_factor"] * 80
        + out["validation_win_rate"] * 75
        - abs(out["validation_max_drawdown_usd"]) * 0.12
    )
    out["status"] = "candidate"
    if out["test_net_pnl_usd"] > 0 and out["test_profit_factor"] > 1.10 and out["test_trades"] >= 8:
        out["status"] = "lower_frequency_test_pass"
    elif out["test_net_pnl_usd"] > 0:
        out["status"] = "positive_watchlist_small_sample"
    else:
        out["status"] = "blocked_negative_oos"
    return out


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    headers = list(rows[0].keys())
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def md_report(summary: dict[str, Any], selected: list[dict[str, Any]]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 决策：`{summary['decision']['status']}`。",
        f"- 是否有测试段通过：`{summary['decision']['has_test_pass']}`。",
        f"- 最佳测试策略：`{summary['decision'].get('best_test_policy')}`。",
        f"- 仍缺真实清算历史：`{not summary['quality_gates']['uses_liquidation_history']}`。",
        "",
        "## 选中策略",
        "",
    ]
    for row in selected:
        lines.append(
            f"- `{row['policy_name']}`：test trades={row['test_trades']}，"
            f"win={row['test_win_rate']:.2%}，PnL={row['test_net_pnl_usd']}，PF={row['test_profit_factor']}，status={row['status']}"
        )
    lines.extend([
        "",
        "## 判断",
        "",
        "V2.10 只验证低频化是否能修复 V2.8 的 5分钟过度交易问题。若测试段仍不稳，下一步必须补真实 liquidation/Bσ 历史，或进一步拆 BTC/ETH 子类和市场状态。",
    ])
    return "\n".join(lines) + "\n"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    start, end = load_v27_window()
    sensors = load_sensor_frame()
    klines = pd.concat([fetch_klines(symbol, start, end) for symbol in SYMBOLS], ignore_index=True)
    klines["timestamp"] = pd.to_datetime(klines["timestamp"], utc=True)

    aggregated: dict[tuple[str, str], pd.DataFrame] = {}
    for timeframe in ["1h", "4h"]:
        btc = aggregate("BTCUSDT", timeframe, klines, sensors)
        btc_enriched = enrich_features(btc)
        btc_close = btc_enriched.set_index("timestamp")["close"]
        eth = aggregate("ETHUSDT", timeframe, klines, sensors)
        eth_enriched = enrich_features(eth, btc_close=btc_close)
        aggregated[("BTCUSDT", timeframe)] = btc_enriched
        aggregated[("ETHUSDT", timeframe)] = eth_enriched

    policies: list[Policy] = []
    for symbol in SYMBOLS:
        for timeframe in ["1h", "4h"]:
            head = "btc_macro_liquidity" if symbol == "BTCUSDT" else "eth_beta_relative"
            hold_options = [6, 12, 24] if timeframe == "1h" else [2, 3, 6]
            for threshold in [0.66, 0.70, 0.74, 0.78]:
                for hold in hold_options:
                    for side_policy in ["long_only", "both"]:
                        policies.append(Policy(
                            symbol=symbol,
                            timeframe=timeframe,
                            head=head,
                            side_policy=side_policy,
                            threshold=threshold,
                            hold_bars=hold,
                            min_q=0.45,
                            min_cavity=0.38,
                            max_bsigma=0.78,
                            cooldown_bars=2,
                            stop_loss=0.018 if symbol == "BTCUSDT" else 0.024,
                            take_profit=0.032 if symbol == "BTCUSDT" else 0.042,
                        ))

    all_trades: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    for policy in policies:
        trades = simulate(aggregated[(policy.symbol, policy.timeframe)], policy)
        all_trades.extend(trades)
        summaries.append(summarize(policy, trades))

    selected: list[dict[str, Any]] = []
    for symbol in SYMBOLS:
        candidates = [s for s in summaries if s["symbol"] == symbol and s["validation_trades"] >= 6]
        candidates.sort(key=lambda r: (r["validation_net_pnl_usd"] > 0, r["selection_score"]), reverse=True)
        if candidates:
            selected.append(candidates[0])

    selected_policy_names = {row["policy_name"] for row in selected}
    selected_trades = [t for t in all_trades if t["policy_name"] in selected_policy_names]
    combined_test = metrics([t for t in selected_trades if t["split"] == "test"])
    best_test = max(summaries, key=lambda r: r["test_net_pnl_usd"])
    has_test_pass = any(s["status"] == "lower_frequency_test_pass" for s in summaries)
    decision_status = "lower_frequency_candidate" if has_test_pass or combined_test["net_pnl_usd"] > 0 else "lower_frequency_still_blocked"

    summary = {
        "version": VERSION,
        "created_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "date_window": {"start": start, "end": end},
        "quality_gates": {
            "uses_v27_l2_book_depth": True,
            "uses_v27_metrics": True,
            "uses_v27_stablecoin_ledger": True,
            "uses_liquidation_history": False,
            "no_online_page_change": True,
        },
        "decision": {
            "status": decision_status,
            "has_test_pass": has_test_pass,
            "best_test_policy": best_test["policy_name"],
            "best_test_pnl_usd": best_test["test_net_pnl_usd"],
            "best_test_pf": best_test["test_profit_factor"],
            "selected_combined_test": combined_test,
            "next_step": "If lower-frequency is still unstable, add real liquidation history before another crypto model iteration.",
        },
        "selected": selected,
    }

    write_csv(OUT_DIR / "hfcd_trading_v2_10_summary.csv", summaries)
    write_csv(OUT_DIR / "hfcd_trading_v2_10_selected_trades.csv", selected_trades)
    write_csv(OUT_DIR / "hfcd_trading_v2_10_all_trades.csv", all_trades)
    (OUT_DIR / "hfcd_trading_v2_10_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Trading_V2_10_CryptoLowerFrequencyRegimeHeads.md").write_text(md_report(summary, selected), encoding="utf-8")

    print(json.dumps(summary["decision"], ensure_ascii=False, indent=2))
    print(f"V2.10 outputs: {OUT_DIR}")


if __name__ == "__main__":
    main()
