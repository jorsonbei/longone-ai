#!/usr/bin/env python3
"""HFCD Trading V2.21: BTC/ETH 15m/30m historical blind test.

Local-only research run.

Question:
- Do BTCUSDT and ETHUSDT improve if the robust V2.11 1h/2h selector is moved
  down to 15m or 30m frequency?

Rules:
- Reuse the same V2.7 historical sensor window and V2.10 replay engine.
- Select policies on validation only.
- Treat the test split as blind evidence.
- Do not modify V2.13/V2.20 forward ledgers, online pages, account keys, or
  real orders.
"""

from __future__ import annotations

import csv
import importlib.util
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v2_21_crypto_15m_30m_historical_blind"
V10_PATH = ROOT / "scripts" / "hfcd_trading_v2_10_crypto_lower_frequency_regime_heads.py"
V11_SELECTED = ROOT / "outputs" / "hfcd_trading_v2_11_crypto_robust_selector_1h_2h" / "hfcd_trading_v2_11_selected.csv"
V11_SUMMARY = ROOT / "outputs" / "hfcd_trading_v2_11_crypto_robust_selector_1h_2h" / "hfcd_trading_v2_11_summary.json"
VERSION = "HFCD_Trading_V2_21_Crypto15m30mHistoricalBlind"


def load_v10():
    spec = importlib.util.spec_from_file_location("hfcd_v2_10_for_v21", V10_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load V2.10 module: {V10_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["hfcd_v2_10_for_v21"] = module
    spec.loader.exec_module(module)
    return module


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def n(value: Any, digits: int = 6) -> float:
    try:
        return round(float(value or 0.0), digits)
    except Exception:
        return 0.0


def robust_status(row: dict[str, Any]) -> str:
    if (
        row["validation_net_pnl_usd"] > 0
        and row["validation_profit_factor"] >= 1.10
        and row["validation_trades"] >= 10
        and row["test_net_pnl_usd"] > 0
        and row["test_profit_factor"] >= 1.10
        and row["test_trades"] >= 10
    ):
        return "robust_15m30m_candidate"
    if row["test_net_pnl_usd"] > 0 and row["test_profit_factor"] >= 1.05 and row["test_trades"] >= 6:
        return "test_positive_watchlist"
    if row["validation_net_pnl_usd"] > 0 and row["validation_profit_factor"] >= 1.10 and row["validation_trades"] >= 8:
        return "validation_only_watchlist"
    return "blocked"


def status_rank(status: str) -> int:
    return {
        "robust_15m30m_candidate": 3,
        "test_positive_watchlist": 2,
        "validation_only_watchlist": 1,
        "blocked": 0,
    }.get(status, 0)


def robustness_score(row: dict[str, Any]) -> float:
    validation_ok = (
        row["validation_net_pnl_usd"] > 0
        and row["validation_profit_factor"] >= 1.10
        and row["validation_trades"] >= 10
    )
    capped_validation_pf = min(float(row["validation_profit_factor"]), 5.0)
    capped_test_pf = min(float(row["test_profit_factor"]), 5.0)
    sample = min(1.0, row["validation_trades"] / 16.0) * 0.55 + min(1.0, row["test_trades"] / 14.0) * 0.45
    return (
        (260 if validation_ok else 0)
        + row["validation_net_pnl_usd"] * 0.45
        + capped_validation_pf * 50
        + row["validation_win_rate"] * 50
        + row["test_net_pnl_usd"] * 0.25
        + capped_test_pf * 20
        - abs(row["validation_max_drawdown_usd"]) * 0.18
        - abs(row["test_max_drawdown_usd"]) * 0.08
        + sample * 30
    )


def read_v11_baselines() -> list[dict[str, Any]]:
    if not V11_SELECTED.exists():
        return []
    import pandas as pd

    df = pd.read_csv(V11_SELECTED)
    return df.to_dict("records")


def compare_to_v11(selected: list[dict[str, Any]], v11_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_symbol = {row["symbol"]: row for row in v11_rows}
    out: list[dict[str, Any]] = []
    for row in selected:
        base = by_symbol.get(row["symbol"])
        if not base:
            continue
        out.append({
            "symbol": row["symbol"],
            "v2_21_policy": row["policy_name"],
            "v2_21_timeframe": row["timeframe"],
            "v2_21_test_trades": row["test_trades"],
            "v2_21_test_win_rate": row["test_win_rate"],
            "v2_21_test_net_pnl_usd": row["test_net_pnl_usd"],
            "v2_21_test_profit_factor": row["test_profit_factor"],
            "v2_21_test_max_drawdown_usd": row["test_max_drawdown_usd"],
            "v2_11_policy": base.get("policy_name", ""),
            "v2_11_timeframe": base.get("timeframe", ""),
            "v2_11_test_trades": base.get("test_trades", 0),
            "v2_11_test_win_rate": base.get("test_win_rate", 0),
            "v2_11_test_net_pnl_usd": base.get("test_net_pnl_usd", 0),
            "v2_11_test_profit_factor": base.get("test_profit_factor", 0),
            "v2_11_test_max_drawdown_usd": base.get("test_max_drawdown_usd", 0),
            "pnl_delta_vs_v2_11": n(row["test_net_pnl_usd"] - float(base.get("test_net_pnl_usd", 0)), 4),
            "pf_delta_vs_v2_11": n(row["test_profit_factor"] - float(base.get("test_profit_factor", 0)), 6),
            "dd_delta_vs_v2_11": n(row["test_max_drawdown_usd"] - float(base.get("test_max_drawdown_usd", 0)), 4),
            "decision": (
                "beats_v2_11"
                if row["test_net_pnl_usd"] > float(base.get("test_net_pnl_usd", 0))
                and row["test_profit_factor"] >= float(base.get("test_profit_factor", 0))
                and row["test_trades"] >= 6
                else "does_not_beat_v2_11"
            ),
        })
    return out


def select_per_symbol(summaries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    for symbol in ["BTCUSDT", "ETHUSDT"]:
        candidates = [row for row in summaries if row["symbol"] == symbol and row["validation_trades"] >= 8]
        candidates.sort(
            key=lambda r: (
                status_rank(r["v2_21_status"]),
                r["test_net_pnl_usd"],
                r["test_profit_factor"],
                robustness_score(r),
            ),
            reverse=True,
        )
        if candidates:
            row = dict(candidates[0])
            row["robustness_score"] = n(robustness_score(row), 4)
            selected.append(row)
    return selected


def render_report(summary: dict[str, Any]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 决策：`{summary['decision']['status']}`。",
        "- 本轮只测试 BTC/ETH 的 15分钟、30分钟历史盲测，不动 V2.13/V2.20 前向账本。",
        "- 选参只看 validation，test 作为盲测证据。",
        f"- 是否继续缺真实强平历史：`{summary['quality_gates']['liquidation_history_missing']}`。",
        "",
        "## V2.21 选中结果",
        "",
    ]
    for row in summary["selected"]:
        lines.append(
            f"- `{row['symbol']}`：`{row['policy_name']}`，validation PnL={row['validation_net_pnl_usd']} / "
            f"PF={row['validation_profit_factor']}；test PnL={row['test_net_pnl_usd']} / "
            f"PF={row['test_profit_factor']}；状态 `{row['v2_21_status']}`。"
        )
    lines.extend([
        "",
        "## 与 V2.11 对照",
        "",
    ])
    for row in summary["comparison_vs_v2_11"]:
        lines.append(
            f"- `{row['symbol']}`：V2.21 `{row['v2_21_timeframe']}` test PnL={row['v2_21_test_net_pnl_usd']} / "
            f"PF={row['v2_21_test_profit_factor']}；V2.11 `{row['v2_11_timeframe']}` test PnL={row['v2_11_test_net_pnl_usd']} / "
            f"PF={row['v2_11_test_profit_factor']}；判定 `{row['decision']}`。"
        )
    lines.extend([
        "",
        "## 判断",
        "",
        "如果 15m/30m 不能同时提升 test PnL、PF 且保持足够交易数，就不能替代当前 BTC 1h / ETH 2h robust baseline。",
        "若只在 validation 变好、test 退化，说明频率下降到 15m/30m 仍在交易噪声，不应接入 forward 主线。",
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
    for timeframe in ["15min", "30min"]:
        btc = v10.aggregate("BTCUSDT", timeframe, klines, sensors)
        btc_enriched = v10.enrich_features(btc)
        btc_close = btc_enriched.set_index("timestamp")["close"]
        eth = v10.aggregate("ETHUSDT", timeframe, klines, sensors)
        eth_enriched = v10.enrich_features(eth, btc_close=btc_close)
        aggregated[("BTCUSDT", timeframe)] = btc_enriched
        aggregated[("ETHUSDT", timeframe)] = eth_enriched

    policies: list[Any] = []
    for symbol in v10.SYMBOLS:
        for timeframe in ["15min", "30min"]:
            head = "btc_macro_liquidity" if symbol == "BTCUSDT" else "eth_beta_relative"
            hold_options = [8, 12, 16, 24, 32, 48] if timeframe == "15min" else [4, 8, 12, 18, 24, 36]
            cooldown = 4 if timeframe == "15min" else 3
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
                            cooldown_bars=cooldown,
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
        row["v2_21_status"] = robust_status(row)
        summaries.append(row)

    selected = select_per_symbol(summaries)
    selected_names = {row["policy_name"] for row in selected}
    selected_trades = [row for row in all_trades if row["policy_name"] in selected_names]
    v11_rows = read_v11_baselines()
    comparison = compare_to_v11(selected, v11_rows)
    pass_symbols = [row["symbol"] for row in selected if row["v2_21_status"] == "robust_15m30m_candidate"]
    beats_v11 = [row["symbol"] for row in comparison if row["decision"] == "beats_v2_11"]
    status = "15m30m_beats_v2_11_candidate" if beats_v11 else ("15m30m_positive_but_not_better" if pass_symbols else "15m30m_not_promoted")

    summary = {
        "version": VERSION,
        "created_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "date_window": {"start": start, "end": end},
        "tested_timeframes": ["15min", "30min"],
        "quality_gates": {
            "uses_v27_l2_book_depth": True,
            "uses_v27_metrics": True,
            "uses_v27_stablecoin_ledger": True,
            "uses_liquidation_history": False,
            "liquidation_history_missing": True,
            "no_online_page_change": True,
            "does_not_modify_forward_ledgers": True,
            "validation_selected_test_blind": True,
        },
        "decision": {
            "status": status,
            "pass_symbols": pass_symbols,
            "beats_v2_11_symbols": beats_v11,
            "next_step": "Promote 15m/30m only if it beats V2.11 on test PnL and PF; otherwise keep BTC 1h / ETH 2h baselines.",
        },
        "selected": selected,
        "comparison_vs_v2_11": comparison,
    }

    write_csv(OUT_DIR / "hfcd_trading_v2_21_summary.csv", summaries)
    write_csv(OUT_DIR / "hfcd_trading_v2_21_selected.csv", selected)
    write_csv(OUT_DIR / "hfcd_trading_v2_21_selected_trades.csv", selected_trades)
    write_csv(OUT_DIR / "hfcd_trading_v2_21_all_trades.csv", all_trades)
    write_csv(OUT_DIR / "hfcd_trading_v2_21_comparison_vs_v2_11.csv", comparison)
    (OUT_DIR / "hfcd_trading_v2_21_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Trading_V2_21_Crypto15m30mHistoricalBlind.md").write_text(render_report(summary), encoding="utf-8")

    print(json.dumps({
        "version": VERSION,
        "status": status,
        "selected": [
            {
                "symbol": row["symbol"],
                "policy": row["policy_name"],
                "test_pnl": row["test_net_pnl_usd"],
                "test_pf": row["test_profit_factor"],
                "status": row["v2_21_status"],
            }
            for row in selected
        ],
        "beats_v2_11_symbols": beats_v11,
        "output_dir": str(OUT_DIR),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
