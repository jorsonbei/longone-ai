#!/usr/bin/env python3
"""HFCD Stock V1.7: broader individual-stock universe blind scan.

This stage intentionally stops deadlocking on NVDA/MSFT. It broadens the
single-stock pool, tests long/short separately across 15m/30m/1h/2h/3h, and
only allows routes that pass train, validation, and test after costs.

It reuses the V1.5 specialist feature stack, but keeps the data-mode honest:
earnings/macro/options features are still proxy-only unless a separate true
historical feed exists. Passing routes are candidates for online paper trading,
not broker execution.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import hfcd_stock_v1_5_nvda_msft_sensor_specialist as v15


VERSION = "HFCD_Stock_V1_7_UniverseExpansionBlind"
ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "outputs" / "hfcd_stock_v1_7_universe_expansion_blind"
RAW_DIR = OUT_DIR / "raw_yahoo_chart"

TARGET_SYMBOLS = [
    # Current online / previous research anchors.
    "AAPL",
    "TSLA",
    "MSFT",
    "NVDA",
    # Mega-cap / AI / cloud.
    "AMZN",
    "GOOGL",
    "META",
    "AVGO",
    "CRM",
    "ORCL",
    # Semis and high-beta technology.
    "AMD",
    "MU",
    "INTC",
    "SMCI",
    "PLTR",
    # High-beta/liquidity names.
    "COIN",
    "MSTR",
    "NFLX",
    "UBER",
    "SHOP",
    # Non-tech liquid large caps for diversification.
    "JPM",
    "XOM",
    "LLY",
    "COST",
]
SENSOR_SYMBOLS = ["SPY", "QQQ", "^VIX", "SOXX", "XLK"]
CADENCES = ["15m", "30m", "1h", "2h", "3h"]
SIDE_POLICIES = ["long_only", "short_only"]


def patch_v15_globals() -> None:
    v15.VERSION = VERSION
    v15.OUT_DIR = OUT_DIR
    v15.RAW_DIR = RAW_DIR
    v15.TARGET_SYMBOLS = TARGET_SYMBOLS
    v15.SENSOR_SYMBOLS = SENSOR_SYMBOLS
    v15.CADENCES = CADENCES
    v15.SIDE_POLICIES = SIDE_POLICIES
    # V1.5 only knew a few symbols. Extend sector routing enough for the
    # public ETF sensors already available in the project.
    v15.v12.SYMBOL_TO_SECTOR.update(
        {
            "AVGO": "SOXX",
            "AMD": "SOXX",
            "MU": "SOXX",
            "INTC": "SOXX",
            "SMCI": "SOXX",
            "AMZN": "QQQ",
            "GOOGL": "QQQ",
            "META": "QQQ",
            "NFLX": "QQQ",
            "PLTR": "QQQ",
            "COIN": "QQQ",
            "MSTR": "QQQ",
            "CRM": "XLK",
            "ORCL": "XLK",
            "SHOP": "QQQ",
            "UBER": "QQQ",
            "JPM": "SPY",
            "XOM": "SPY",
            "LLY": "SPY",
            "COST": "SPY",
        }
    )


def normalize_status(status: str) -> str:
    return status.replace("stock_v1_5_", "stock_v1_7_")


def normalize_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item["status"] = normalize_status(str(item.get("status", "")))
        item["version"] = VERSION
        out.append(item)
    return out


def rank_status(status: str) -> int:
    if status in {"stock_v1_5_online_paper_candidate", "stock_v1_7_online_paper_candidate"}:
        return 3
    if status == "validation_test_watchlist":
        return 2
    if status == "test_positive_watchlist":
        return 1
    return 0


def select_best(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    for symbol in TARGET_SYMBOLS:
        for side_policy in SIDE_POLICIES:
            group = [r for r in rows if r["symbol"] == symbol and r["side_policy"] == side_policy]
            group.sort(
                key=lambda r: (
                    rank_status(str(r["status"])),
                    float(r["selection_score"]),
                    float(r["test_net_pnl_usd"]),
                    float(r["test_profit_factor"]),
                ),
                reverse=True,
            )
            if group:
                selected.append(dict(group[0]))
    return selected


def render_report(summary: dict[str, Any]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        f"Generated: `{summary['generated_at']}`",
        "",
        "## 决策",
        "",
        f"- `{summary['decision']}`",
        f"- `deployment_allowed`: `{str(summary['deployment_allowed']).lower()}`",
        f"- candidate_count: `{summary['candidate_count']}`",
        f"- watchlist_count: `{summary['watchlist_count']}`",
        "- 本阶段扩展股票池，不继续死磕 NVDA/MSFT。",
        "- 代理事件/期权传感器不会被包装成真实 Gamma/OI 或真实财报数据。",
        "",
        "## 允许接入线上模拟交易候选",
        "",
    ]
    if summary["candidate_routes"]:
        for row in summary["candidate_routes"]:
            lines.append(
                f"- `{row['symbol']}` `{row['cadence']}` `{row['side_policy']}`；"
                f"train={row['train_net_pnl_usd']} PF={row['train_profit_factor']} trades={row['train_trades']}；"
                f"val={row['validation_net_pnl_usd']} PF={row['validation_profit_factor']} trades={row['validation_trades']}；"
                f"test={row['test_net_pnl_usd']} PF={row['test_profit_factor']} trades={row['test_trades']}。"
            )
    else:
        lines.append("- 无。")
    lines.extend(["", "## 每个标的/方向最优路线", ""])
    for row in summary["selected_routes"]:
        lines.append(
            f"- `{row['symbol']}` `{row['side_policy']}` -> `{row['cadence']}` status=`{row['status']}`；"
            f"train={row['train_net_pnl_usd']} val={row['validation_net_pnl_usd']} test={row['test_net_pnl_usd']} "
            f"testPF={row['test_profit_factor']}。"
        )
    lines.extend(["", "## 下一步", "", summary["next_action"]])
    return "\n".join(lines) + "\n"


def main() -> None:
    patch_v15_globals()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    coverage: list[dict[str, Any]] = []
    datasets = v15.build_base_datasets(coverage)

    summaries: list[dict[str, Any]] = []
    trades_all: list[dict[str, Any]] = []
    gates_all: list[dict[str, Any]] = []
    models: list[dict[str, Any]] = []

    for symbol in TARGET_SYMBOLS:
        for cadence in CADENCES:
            print(f"[{v15.utc_now()}] V1.7 testing {symbol} {cadence} long/short", flush=True)
            df0 = datasets.get((symbol, cadence))
            if df0 is None or len(df0) < 90:
                coverage.append({"symbol": symbol, "cadence": cadence, "source": "target_route", "rows": 0, "status": "missing_or_low"})
                continue
            df = v15.add_specialist_features(df0, symbol, cadence, datasets)
            train_end = int(len(df) * 0.60)
            model = v15.fit_ridge(df.iloc[:train_end].copy())
            df = v15.apply_model(df, model)
            for side_policy in SIDE_POLICIES:
                models.append(
                    {
                        "symbol": symbol,
                        "cadence": cadence,
                        "side_policy": side_policy,
                        "model_available": bool(model.get("available")),
                        "model_train_rows": int(model.get("train_rows", 0)),
                        "model_mae": v15.n(model.get("mae", 0.0), 8),
                        "features": ",".join(v15.FEATURES),
                        "true_options_gamma_oi_available": False,
                        "true_earnings_calendar_available": False,
                        "true_macro_calendar_available": False,
                    }
                )
                for policy in v15.build_policies(symbol, cadence, side_policy):
                    trades, gates = v15.simulate(df, policy, model)
                    trades_all.extend(trades)
                    gates_all.extend(gates)
                    summaries.append(v15.summarize(policy, trades, model))

    selected_raw = select_best(summaries)
    selected_names = {r["policy_name"] for r in selected_raw}
    selected_trades = [t for t in trades_all if t["policy_name"] in selected_names]
    summaries_norm = normalize_rows(summaries)
    selected = normalize_rows(selected_raw)
    selected_trades = [{**t, "version": VERSION} for t in selected_trades]
    candidates = [r for r in selected if r["status"] == "stock_v1_7_online_paper_candidate"]
    watchlist = [r for r in selected if r["status"] in {"validation_test_watchlist", "test_positive_watchlist"}]
    decision = "stock_v1_7_online_paper_ready" if candidates else ("stock_v1_7_watchlist_only" if watchlist else "stock_v1_7_blocked")

    png_path = OUT_DIR / "HFCD_Stock_V1_7_UniverseExpansionBlind.png"
    figure_generated = v15.build_plot(selected, png_path)
    permission_rows = [
        {
            "symbol": r["symbol"],
            "cadence": r["cadence"],
            "side_policy": r["side_policy"],
            "allowed": bool(r["status"] == "stock_v1_7_online_paper_candidate"),
            "status": r["status"],
            "train_pnl_usd": r["train_net_pnl_usd"],
            "validation_pnl_usd": r["validation_net_pnl_usd"],
            "test_pnl_usd": r["test_net_pnl_usd"],
            "test_profit_factor": r["test_profit_factor"],
        }
        for r in selected
    ]
    output_files = {
        "summary": str(OUT_DIR / "hfcd_stock_v1_7_summary.json"),
        "route_summary": str(OUT_DIR / "hfcd_stock_v1_7_route_summary.csv"),
        "selected_routes": str(OUT_DIR / "hfcd_stock_v1_7_selected_routes.csv"),
        "selected_trades": str(OUT_DIR / "hfcd_stock_v1_7_selected_trades.csv"),
        "gate_audit": str(OUT_DIR / "hfcd_stock_v1_7_gate_audit.csv"),
        "model_audit": str(OUT_DIR / "hfcd_stock_v1_7_model_audit.csv"),
        "data_coverage": str(OUT_DIR / "hfcd_stock_v1_7_data_coverage.csv"),
        "permission_matrix": str(OUT_DIR / "hfcd_stock_v1_7_direction_permission_matrix.csv"),
        "report": str(OUT_DIR / "HFCD_Stock_V1_7_UniverseExpansionBlind.md"),
        "figure": str(png_path),
    }
    summary = {
        "version": VERSION,
        "generated_at": v15.utc_now(),
        "decision": decision,
        "promotion_status": "candidate_for_online_paper" if candidates else "blocked",
        "deployment_allowed": bool(candidates),
        "online_or_broker_touched": False,
        "data_mode": "yahoo_public_intraday_plus_vix_sector_proxy_universe_blind",
        "target_symbols": TARGET_SYMBOLS,
        "cadences": CADENCES,
        "side_policies": SIDE_POLICIES,
        "candidate_count": len(candidates),
        "watchlist_count": len(watchlist),
        "candidate_routes": candidates,
        "selected_routes": selected,
        "permission_matrix": permission_rows,
        "quality_gates": {
            "train_validation_test_required": True,
            "forecast_edge_gate_used": True,
            "train_only_model_fit": True,
            "sector_sensor_used": True,
            "proxy_sensors_not_promotable_as_true_feeds": True,
            "figure_generated": figure_generated,
        },
        "output_files": output_files,
        "next_action": (
            "Add only stock_v1_7_online_paper_candidate routes to longone online paper trading. "
            "Keep watchlist/blocked routes offline and continue broad stock-pool scanning instead of tuning one name."
        ),
    }

    v15.write_csv(OUT_DIR / "hfcd_stock_v1_7_route_summary.csv", summaries_norm)
    v15.write_csv(OUT_DIR / "hfcd_stock_v1_7_selected_routes.csv", selected)
    v15.write_csv(OUT_DIR / "hfcd_stock_v1_7_selected_trades.csv", selected_trades)
    v15.write_csv(OUT_DIR / "hfcd_stock_v1_7_gate_audit.csv", gates_all)
    v15.write_csv(OUT_DIR / "hfcd_stock_v1_7_model_audit.csv", models)
    v15.write_csv(OUT_DIR / "hfcd_stock_v1_7_data_coverage.csv", coverage)
    v15.write_csv(OUT_DIR / "hfcd_stock_v1_7_direction_permission_matrix.csv", permission_rows)
    (OUT_DIR / "hfcd_stock_v1_7_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Stock_V1_7_UniverseExpansionBlind.md").write_text(render_report(summary), encoding="utf-8")

    print(
        json.dumps(
            {
                "version": VERSION,
                "decision": decision,
                "deployment_allowed": bool(candidates),
                "candidate_count": len(candidates),
                "watchlist_count": len(watchlist),
                "candidate_routes": [
                    {
                        "symbol": r["symbol"],
                        "cadence": r["cadence"],
                        "side_policy": r["side_policy"],
                        "train_pnl": r["train_net_pnl_usd"],
                        "validation_pnl": r["validation_net_pnl_usd"],
                        "test_pnl": r["test_net_pnl_usd"],
                        "test_pf": r["test_profit_factor"],
                    }
                    for r in candidates
                ],
                "output_dir": str(OUT_DIR),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
