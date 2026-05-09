#!/usr/bin/env python3
"""HFCD Stock V1.8: second-wave stock expansion blind scan.

This stage continues the stock line without deadlocking on one name. It focuses
only on the second-wave universe requested by the user and keeps the promotion
rule unchanged: train, validation, and test must all pass after costs before a
route can enter longone online paper trading.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import hfcd_stock_v1_5_nvda_msft_sensor_specialist as v15


VERSION = "HFCD_Stock_V1_8_SecondWaveExpansionBlind"
ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "outputs" / "hfcd_stock_v1_8_second_wave_expansion_blind"
RAW_DIR = OUT_DIR / "raw_yahoo_chart"

TARGET_SYMBOLS = [
    "META",
    "GOOGL",
    "AVGO",
    "ORCL",
    "PLTR",
    "COIN",
    "MSTR",
    "NFLX",
    "UBER",
    "JPM",
    "XOM",
    "LLY",
    "COST",
]
SENSOR_SYMBOLS = ["SPY", "QQQ", "^VIX", "SOXX", "XLK"]
CADENCES = ["15m", "30m", "1h", "2h", "3h"]
SIDE_POLICIES = ["long_only", "short_only"]
CANDIDATE_STATUS = "stock_v1_8_online_paper_candidate"
V17_SELECTED_PATH = ROOT / "outputs" / "hfcd_stock_v1_7_universe_expansion_blind" / "hfcd_stock_v1_7_selected_routes.csv"
HINT_ROWS: dict[tuple[str, str, str], dict[str, Any]] = {}


def fnum(row: dict[str, Any], key: str, default: float) -> float:
    try:
        return float(row.get(key, default))
    except Exception:
        return default


def inum(row: dict[str, Any], key: str, default: int) -> int:
    try:
        return int(float(row.get(key, default)))
    except Exception:
        return default


def load_v17_hints() -> None:
    """Use V1.7 selected routes as neighborhoods, not as promotion evidence."""
    HINT_ROWS.clear()
    if not V17_SELECTED_PATH.exists():
        return
    import csv

    with V17_SELECTED_PATH.open("r", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            symbol = str(row.get("symbol", ""))
            side = str(row.get("side_policy", ""))
            cadence = str(row.get("cadence", ""))
            if symbol in TARGET_SYMBOLS and side in SIDE_POLICIES and cadence in CADENCES:
                HINT_ROWS[(symbol, cadence, side)] = row


def patch_globals() -> None:
    load_v17_hints()
    v15.VERSION = VERSION
    v15.OUT_DIR = OUT_DIR
    v15.RAW_DIR = RAW_DIR
    v15.TARGET_SYMBOLS = TARGET_SYMBOLS
    v15.SENSOR_SYMBOLS = SENSOR_SYMBOLS
    v15.CADENCES = CADENCES
    v15.SIDE_POLICIES = SIDE_POLICIES
    v15.v10.BASE_COST.update(
        {
            "META": 0.00026,
            "GOOGL": 0.00024,
            "AVGO": 0.00036,
            "ORCL": 0.00028,
            "PLTR": 0.00045,
            "COIN": 0.00055,
            "MSTR": 0.00065,
            "NFLX": 0.00034,
            "UBER": 0.00034,
            "JPM": 0.00024,
            "XOM": 0.00024,
            "LLY": 0.00030,
            "COST": 0.00026,
        }
    )
    v15.v12.SYMBOL_TO_SECTOR.update(
        {
            "AVGO": "SOXX",
            "META": "QQQ",
            "GOOGL": "QQQ",
            "PLTR": "QQQ",
            "COIN": "QQQ",
            "MSTR": "QQQ",
            "NFLX": "QQQ",
            "UBER": "QQQ",
            "ORCL": "XLK",
            "JPM": "SPY",
            "XOM": "SPY",
            "LLY": "SPY",
            "COST": "SPY",
        }
    )
    v15.build_policies = build_policies_v18


def build_policies_v18(symbol: str, cadence: str, side_policy: str) -> list[v15.Policy]:
    """Search around V1.7 near-miss routes to keep runtime and overfit risk bounded."""
    hint = HINT_ROWS.get((symbol, cadence, side_policy))
    if not hint:
        return []
    base_score = fnum(hint, "score_floor", 0.60 if side_policy == "long_only" else 0.62)
    base_edge = fnum(hint, "edge_floor", 0.0)
    base_hold = inum(hint, "hold_bars", 1)
    base_stop = fnum(hint, "stop_atr", 1.3)
    base_take = fnum(hint, "take_atr", 2.3)
    base_event = fnum(hint, "max_event_risk", 0.76)
    base_gamma = fnum(hint, "min_gamma_health", 0.40)
    score_floors = sorted({round(max(0.52, base_score - 0.02), 2), round(base_score, 2), round(min(0.72, base_score + 0.02), 2)})
    edge_floors = sorted({round(max(0.0, base_edge - 0.00015), 5), round(base_edge, 5)})
    max_hold = {"15m": 4, "30m": 4, "1h": 3, "2h": 2, "3h": 2}[cadence]
    holds = sorted({max(1, base_hold), min(max_hold, base_hold + 1)})
    alt_exit = (1.3, 2.3) if base_stop <= 1.1 else (1.05, 1.8)
    exits = sorted({(round(base_stop, 2), round(base_take, 2)), alt_exit})
    max_events = sorted({round(base_event, 2), round(min(0.84, base_event + 0.08), 2)})
    min_gamma_healths = [round(base_gamma, 2)]
    session_policies = ["allow_close_avoid_open"]
    out: list[v15.Policy] = []
    for score_floor in score_floors:
        for edge_floor in edge_floors:
            for hold in holds:
                for stop_atr, take_atr in exits:
                    for max_event in max_events:
                        for min_gamma in min_gamma_healths:
                            for session_policy in session_policies:
                                out.append(
                                    v15.Policy(
                                        symbol=symbol,
                                        cadence=cadence,
                                        side_policy=side_policy,
                                        score_floor=score_floor,
                                        edge_floor=edge_floor,
                                        hold_bars=hold,
                                        stop_atr=stop_atr,
                                        take_atr=take_atr,
                                        min_cavity=0.28,
                                        min_eta_health=0.20,
                                        max_event_risk=max_event,
                                        min_gamma_health=min_gamma,
                                        session_policy=session_policy,
                                    )
                                )
    return out


def normalize_status(status: str) -> str:
    if status == "stock_v1_5_online_paper_candidate":
        return CANDIDATE_STATUS
    return status


def normalize_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item["status"] = normalize_status(str(item.get("status", "")))
        item["version"] = VERSION
        out.append(item)
    return out


def rank_status(status: str) -> int:
    if status == CANDIDATE_STATUS:
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
        "- 第二批股票不接券商实盘，只允许通过路线进入 longone 线上模拟账本。",
        "- 事件/期权/Gamma 仍是代理传感器，不作为真实高维数据证明。",
        "",
        "## 候选路线",
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
            f"train={row['train_net_pnl_usd']} val={row['validation_net_pnl_usd']} "
            f"test={row['test_net_pnl_usd']} testPF={row['test_profit_factor']}。"
        )
    lines.extend(["", "## 下一步", "", summary["next_action"]])
    return "\n".join(lines) + "\n"


def main() -> None:
    patch_globals()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    coverage: list[dict[str, Any]] = []
    datasets = v15.build_base_datasets(coverage)
    summaries: list[dict[str, Any]] = []
    trades_all: list[dict[str, Any]] = []
    gates_all: list[dict[str, Any]] = []
    models: list[dict[str, Any]] = []

    for symbol in TARGET_SYMBOLS:
        for cadence in CADENCES:
            print(f"[{v15.utc_now()}] V1.8 testing {symbol} {cadence} long/short", flush=True)
            df0 = datasets.get((symbol, cadence))
            if df0 is None or len(df0) < 90:
                coverage.append({"symbol": symbol, "cadence": cadence, "source": "target_route", "rows": 0, "status": "missing_or_low"})
                continue
            df = v15.add_specialist_features(df0, symbol, cadence, datasets)
            train_end = int(len(df) * 0.60)
            model = v15.fit_ridge(df.iloc[:train_end].copy())
            df = v15.apply_model(df, model)
            for side_policy in SIDE_POLICIES:
                policies = v15.build_policies(symbol, cadence, side_policy)
                if not policies:
                    continue
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
                for policy in policies:
                    trades, gates = v15.simulate(df, policy, model)
                    trades_all.extend(trades)
                    gates_all.extend(gates)
                    summaries.append(v15.summarize(policy, trades, model))

    summaries_norm = normalize_rows(summaries)
    selected = normalize_rows(select_best(summaries_norm))
    selected_names = {r["policy_name"] for r in selected}
    selected_trades = [{**t, "version": VERSION} for t in trades_all if t["policy_name"] in selected_names]
    candidates = [r for r in selected if r["status"] == CANDIDATE_STATUS]
    watchlist = [r for r in selected if r["status"] in {"validation_test_watchlist", "test_positive_watchlist"}]
    decision = "stock_v1_8_online_paper_ready" if candidates else ("stock_v1_8_watchlist_only" if watchlist else "stock_v1_8_blocked")

    png_path = OUT_DIR / "HFCD_Stock_V1_8_SecondWaveExpansionBlind.png"
    figure_generated = v15.build_plot(selected, png_path)
    permission_rows = [
        {
            "symbol": r["symbol"],
            "cadence": r["cadence"],
            "side_policy": r["side_policy"],
            "allowed": bool(r["status"] == CANDIDATE_STATUS),
            "status": r["status"],
            "train_pnl_usd": r["train_net_pnl_usd"],
            "validation_pnl_usd": r["validation_net_pnl_usd"],
            "test_pnl_usd": r["test_net_pnl_usd"],
            "test_profit_factor": r["test_profit_factor"],
        }
        for r in selected
    ]
    output_files = {
        "summary": str(OUT_DIR / "hfcd_stock_v1_8_summary.json"),
        "route_summary": str(OUT_DIR / "hfcd_stock_v1_8_route_summary.csv"),
        "selected_routes": str(OUT_DIR / "hfcd_stock_v1_8_selected_routes.csv"),
        "selected_trades": str(OUT_DIR / "hfcd_stock_v1_8_selected_trades.csv"),
        "gate_audit": str(OUT_DIR / "hfcd_stock_v1_8_gate_audit.csv"),
        "model_audit": str(OUT_DIR / "hfcd_stock_v1_8_model_audit.csv"),
        "data_coverage": str(OUT_DIR / "hfcd_stock_v1_8_data_coverage.csv"),
        "permission_matrix": str(OUT_DIR / "hfcd_stock_v1_8_direction_permission_matrix.csv"),
        "report": str(OUT_DIR / "HFCD_Stock_V1_8_SecondWaveExpansionBlind.md"),
        "figure": str(png_path),
    }
    summary = {
        "version": VERSION,
        "generated_at": v15.utc_now(),
        "decision": decision,
        "promotion_status": "candidate_for_online_paper" if candidates else "blocked",
        "deployment_allowed": bool(candidates),
        "online_or_broker_touched": False,
        "data_mode": "yahoo_public_intraday_plus_vix_sector_proxy_second_wave_blind",
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
            "Add only stock_v1_8_online_paper_candidate routes to longone online paper trading. "
            "Keep watchlist/blocked routes offline; if no candidates exist, expand the stock universe again instead of hard-tuning one name."
        ),
    }
    v15.write_csv(OUT_DIR / "hfcd_stock_v1_8_route_summary.csv", summaries_norm)
    v15.write_csv(OUT_DIR / "hfcd_stock_v1_8_selected_routes.csv", selected)
    v15.write_csv(OUT_DIR / "hfcd_stock_v1_8_selected_trades.csv", selected_trades)
    v15.write_csv(OUT_DIR / "hfcd_stock_v1_8_gate_audit.csv", gates_all)
    v15.write_csv(OUT_DIR / "hfcd_stock_v1_8_model_audit.csv", models)
    v15.write_csv(OUT_DIR / "hfcd_stock_v1_8_data_coverage.csv", coverage)
    v15.write_csv(OUT_DIR / "hfcd_stock_v1_8_direction_permission_matrix.csv", permission_rows)
    (OUT_DIR / "hfcd_stock_v1_8_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Stock_V1_8_SecondWaveExpansionBlind.md").write_text(render_report(summary), encoding="utf-8")
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
