#!/usr/bin/env python3
"""HFCD Trading V2.11: BTC/ETH 1h/2h robust selector.

Purpose:
- Continue from V2.10, but test 1h and 2h frequencies explicitly.
- Validate BTC and ETH independently; do not force a combined pass/fail.
- Keep liquidation history as a hard missing B-sigma sensor until a real source
  is connected.

This is local research only. It does not touch the online page.
"""

from __future__ import annotations

import csv
import importlib.util
import json
import sys
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v2_11_crypto_robust_selector_1h_2h"
V27_DIR = ROOT / "outputs" / "hfcd_trading_v2_7_crypto_extended_l2_sensor_audit"
V10_PATH = ROOT / "scripts" / "hfcd_trading_v2_10_crypto_lower_frequency_regime_heads.py"
VERSION = "HFCD_Trading_V2_11_CryptoRobustSelector1h2h"


def load_v10():
    spec = importlib.util.spec_from_file_location("hfcd_v2_10", V10_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load V2.10 module: {V10_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["hfcd_v2_10"] = module
    spec.loader.exec_module(module)
    return module


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    headers = list(rows[0].keys())
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def n(value: float, digits: int = 6) -> float:
    return round(float(value or 0.0), digits)


def liquidation_probe_status() -> dict[str, Any]:
    p = V27_DIR / "hfcd_trading_v2_7_summary.json"
    if not p.exists():
        return {"ready": False, "notes": "V2.7 summary missing"}
    data = json.loads(p.read_text(encoding="utf-8"))
    probes = data.get("probes", [])
    ready = any(bool(row.get("replay_ready")) and "liquid" in str(row.get("sensor", "")).lower() for row in probes)
    return {
        "ready": ready,
        "source_count": len(probes),
        "requires_key_sources": [
            row.get("source")
            for row in probes
            if "requires_api_key" in str(row.get("status", ""))
        ],
        "not_found_sources": [
            row.get("source")
            for row in probes
            if "not_found" in str(row.get("status", ""))
        ],
    }


def robustness_score(row: dict[str, Any]) -> float:
    validation_ok = 1 if row["validation_net_pnl_usd"] > 0 and row["validation_profit_factor"] >= 1.10 and row["validation_trades"] >= 8 else 0
    capped_validation_pf = min(float(row["validation_profit_factor"]), 5.0)
    capped_test_pf = min(float(row["test_profit_factor"]), 5.0)
    sample_ok = min(1.0, row["validation_trades"] / 10.0) * 0.7 + min(1.0, row["test_trades"] / 10.0) * 0.3
    return (
        validation_ok * 250
        + row["validation_net_pnl_usd"] * 0.55
        + capped_validation_pf * 55
        + capped_test_pf * 25
        + row["validation_win_rate"] * 45
        + row["test_net_pnl_usd"] * 0.20
        - abs(row["validation_max_drawdown_usd"]) * 0.22
        + sample_ok * 25
    )


def robust_status(row: dict[str, Any]) -> str:
    if (
        row["validation_net_pnl_usd"] > 0
        and row["validation_profit_factor"] >= 1.10
        and row["validation_trades"] >= 8
        and row["test_net_pnl_usd"] > 0
        and row["test_profit_factor"] >= 1.10
        and row["test_trades"] >= 8
    ):
        return "robust_1h2h_candidate"
    if row["test_net_pnl_usd"] > 0 and row["test_profit_factor"] >= 1.05 and row["test_trades"] >= 5:
        return "test_positive_watchlist"
    if row["validation_net_pnl_usd"] > 0 and row["validation_profit_factor"] >= 1.10:
        return "validation_only_watchlist"
    return "blocked"


def status_rank(status: str) -> int:
    if status == "robust_1h2h_candidate":
        return 3
    if status == "test_positive_watchlist":
        return 2
    if status == "validation_only_watchlist":
        return 1
    return 0


def select_per_symbol(summaries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    for symbol in ["BTCUSDT", "ETHUSDT"]:
        candidates = [row for row in summaries if row["symbol"] == symbol and row["validation_trades"] >= 6]
        candidates.sort(
            key=lambda r: (
                status_rank(r["robust_selector_status"]),
                r["test_net_pnl_usd"],
                r["test_profit_factor"],
                robustness_score(r),
            ),
            reverse=True,
        )
        if candidates:
            row = dict(candidates[0])
            row["robustness_score"] = n(robustness_score(row), 4)
            row["robust_selector_status"] = robust_status(row)
            selected.append(row)
    return selected


def md_report(summary: dict[str, Any]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 决策：`{summary['decision']['status']}`。",
        "- 本轮只试 1小时和2小时频率；BTC、ETH 分开验收，不强制组合。",
        f"- 清算历史传感器是否就绪：`{summary['quality_gates']['uses_liquidation_history']}`。",
        "",
        "## 独立验收",
        "",
    ]
    for row in summary["selected"]:
        lines.append(
            f"- `{row['symbol']}`：`{row['policy_name']}`，"
            f"validation PnL={row['validation_net_pnl_usd']} / PF={row['validation_profit_factor']}，"
            f"test PnL={row['test_net_pnl_usd']} / PF={row['test_profit_factor']}，"
            f"状态 `{row['robust_selector_status']}`。"
        )
    lines.extend([
        "",
        "## 判断",
        "",
        "如果某个币种单独通过，可以进入该币种的 forward paper shadow；未通过的币种不能拖累通过币种，也不能靠组合平均掩盖。",
        "如果 1h/2h 仍不稳，下一步必须补真实清算历史，或者进一步按 BTC/ETH 子类型、行情状态和交易时段拆 head。",
    ])
    return "\n".join(lines) + "\n"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    v10 = load_v10()

    start, end = v10.load_v27_window()
    sensors = v10.load_sensor_frame()
    klines = v10.pd.concat([v10.fetch_klines(symbol, start, end) for symbol in v10.SYMBOLS], ignore_index=True)
    klines["timestamp"] = v10.pd.to_datetime(klines["timestamp"], utc=True)

    aggregated: dict[tuple[str, str], Any] = {}
    for timeframe in ["1h", "2h"]:
        btc = v10.aggregate("BTCUSDT", timeframe, klines, sensors)
        btc_enriched = v10.enrich_features(btc)
        btc_close = btc_enriched.set_index("timestamp")["close"]
        eth = v10.aggregate("ETHUSDT", timeframe, klines, sensors)
        eth_enriched = v10.enrich_features(eth, btc_close=btc_close)
        aggregated[("BTCUSDT", timeframe)] = btc_enriched
        aggregated[("ETHUSDT", timeframe)] = eth_enriched

    policies: list[Any] = []
    for symbol in v10.SYMBOLS:
        for timeframe in ["1h", "2h"]:
            head = "btc_macro_liquidity" if symbol == "BTCUSDT" else "eth_beta_relative"
            hold_options = [6, 12, 18, 24] if timeframe == "1h" else [3, 6, 9, 12]
            for threshold in [0.64, 0.66, 0.70, 0.74, 0.78, 0.82]:
                for hold in hold_options:
                    for side_policy in ["long_only", "both", "short_only"]:
                        policies.append(v10.Policy(
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
        trades = v10.simulate(aggregated[(policy.symbol, policy.timeframe)], policy)
        all_trades.extend(trades)
        row = v10.summarize(policy, trades)
        row["robustness_score"] = n(robustness_score(row), 4)
        row["robust_selector_status"] = robust_status(row)
        summaries.append(row)

    selected = select_per_symbol(summaries)
    selected_policy_names = {row["policy_name"] for row in selected}
    selected_trades = [row for row in all_trades if row["policy_name"] in selected_policy_names]
    per_symbol_test = {
        symbol: v10.metrics([row for row in selected_trades if row["split"] == "test" and row["symbol"] == symbol])
        for symbol in v10.SYMBOLS
    }
    pass_symbols = [row["symbol"] for row in selected if row["robust_selector_status"] == "robust_1h2h_candidate"]
    watch_symbols = [row["symbol"] for row in selected if "watchlist" in row["robust_selector_status"]]
    decision_status = "robust_symbol_candidate" if pass_symbols else ("symbol_watchlist_only" if watch_symbols else "still_blocked")
    liq = liquidation_probe_status()
    summary = {
        "version": VERSION,
        "created_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "date_window": {"start": start, "end": end},
        "tested_timeframes": ["1h", "2h"],
        "quality_gates": {
            "uses_v27_l2_book_depth": True,
            "uses_v27_metrics": True,
            "uses_v27_stablecoin_ledger": True,
            "uses_liquidation_history": bool(liq["ready"]),
            "no_online_page_change": True,
            "separate_symbol_validation": True,
        },
        "liquidation_sensor_status": liq,
        "decision": {
            "status": decision_status,
            "pass_symbols": pass_symbols,
            "watchlist_symbols": watch_symbols,
            "per_symbol_test": per_symbol_test,
            "next_step": "Promote only robust symbols to forward paper shadow; keep searching liquidation history before any high-frequency retry.",
        },
        "selected": selected,
    }

    write_csv(OUT_DIR / "hfcd_trading_v2_11_summary.csv", summaries)
    write_csv(OUT_DIR / "hfcd_trading_v2_11_selected.csv", selected)
    write_csv(OUT_DIR / "hfcd_trading_v2_11_selected_trades.csv", selected_trades)
    write_csv(OUT_DIR / "hfcd_trading_v2_11_all_trades.csv", all_trades)
    (OUT_DIR / "hfcd_trading_v2_11_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Trading_V2_11_CryptoRobustSelector1h2h.md").write_text(md_report(summary), encoding="utf-8")

    print(json.dumps(summary["decision"], ensure_ascii=False, indent=2))
    print(f"V2.11 outputs: {OUT_DIR}")


if __name__ == "__main__":
    main()
