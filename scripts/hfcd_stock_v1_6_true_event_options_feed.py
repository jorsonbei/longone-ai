#!/usr/bin/env python3
"""HFCD Stock V1.6: true event/options feed attempt.

This stage keeps V1.5's NVDA/MSFT specialist blind-test framework but adds a
strict real-data coverage layer:
- FOMC dates are parsed from the Federal Reserve public calendar when available.
- CPI release dates are attempted from public BLS endpoints; if the release
  calendar is blocked/unavailable, the CPI event sensor is not used.
- Earnings dates are attempted from Yahoo endpoints; if only current/future or
  no historical events are returned, the earnings event sensor is not used.
- Options chain/OI is attempted from Yahoo; current snapshots are logged but
  are not injected into historical bars because that would leak future/current
  state into the blind test.

No Worker/D1, online page, broker, or real order is touched.
"""

from __future__ import annotations

import csv
import json
import re
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd

import hfcd_stock_v1_5_nvda_msft_sensor_specialist as v15


VERSION = "HFCD_Stock_V1_6_TrueEventOptionsFeed"
ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "outputs" / "hfcd_stock_v1_6_true_event_options_feed"
RAW_DIR = OUT_DIR / "raw_feed_attempts"
TARGET_SYMBOLS = v15.TARGET_SYMBOLS
CADENCES = v15.CADENCES
SIDE_POLICIES = v15.SIDE_POLICIES
FEATURES = list(
    dict.fromkeys(
        v15.FEATURES
        + [
            "fomc_event_window_true",
            "cpi_event_window_true",
            "earnings_event_window_true",
            "true_event_risk",
            "options_gamma_snapshot_available",
        ]
    )
)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def http_text(url: str, timeout: int = 25) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 HFCD-Stock-V1.6",
            "Accept": "text/html,application/json,*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "ignore")


def http_json(url: str, timeout: int = 25) -> Any:
    return json.loads(http_text(url, timeout=timeout))


def write_json_cache(name: str, payload: Any) -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    (RAW_DIR / name).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def fetch_fomc_dates(coverage: list[dict[str, Any]]) -> set[date]:
    url = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
    try:
        text = http_text(url)
        dates = sorted({datetime.strptime(x, "%Y%m%d").date() for x in re.findall(r"monetary(\d{8})a", text)})
        write_json_cache("fomc_calendar_dates.json", {"source": url, "dates": [d.isoformat() for d in dates]})
        coverage.append(
            {
                "feed": "fomc_calendar",
                "source": url,
                "rows": len(dates),
                "status": "ok" if dates else "empty",
                "data_mode": "true_public_federal_reserve_calendar",
            }
        )
        return set(dates)
    except Exception as exc:
        coverage.append({"feed": "fomc_calendar", "source": url, "rows": 0, "status": f"error:{exc}", "data_mode": "true_feed_failed"})
        return set()


def fetch_bls_cpi_release_dates(coverage: list[dict[str, Any]]) -> set[date]:
    # The BLS public data API gives CPI values, but not a reliable release
    # timestamp schedule. The HTML schedule is often bot-blocked. Do not infer
    # release dates from CPI periods.
    schedule_url = "https://www.bls.gov/schedule/news_release/cpi.htm"
    api_url = "https://api.bls.gov/publicAPI/v2/timeseries/data/CUSR0000SA0?startyear=2025&endyear=2026"
    rows = 0
    try:
        data = http_json(api_url)
        rows = len((((data.get("Results") or {}).get("series") or [{}])[0]).get("data") or [])
        write_json_cache("bls_cpi_series_snapshot.json", data)
    except Exception as exc:
        coverage.append({"feed": "cpi_series", "source": api_url, "rows": 0, "status": f"error:{exc}", "data_mode": "true_feed_failed"})
    try:
        text = http_text(schedule_url)
        found = sorted({datetime.strptime(x, "%B %d, %Y").date() for x in re.findall(r"([A-Z][a-z]+ \d{1,2}, 20\d{2})", text)})
        coverage.append(
            {
                "feed": "cpi_release_calendar",
                "source": schedule_url,
                "rows": len(found),
                "status": "ok" if found else "empty",
                "data_mode": "true_public_bls_release_calendar",
            }
        )
        return set(found)
    except Exception as exc:
        coverage.append(
            {
                "feed": "cpi_release_calendar",
                "source": schedule_url,
                "rows": 0,
                "status": f"blocked_or_unavailable:{exc}",
                "data_mode": f"cpi_series_rows_{rows}_but_no_release_timestamp",
            }
        )
        return set()


def fetch_yahoo_earnings_dates(symbol: str, coverage: list[dict[str, Any]]) -> set[date]:
    dates: set[date] = set()
    chart_url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?"
        + urllib.parse.urlencode({"range": "1y", "interval": "1d", "events": "earnings"})
    )
    try:
        data = http_json(chart_url)
        write_json_cache(f"{symbol}_yahoo_chart_earnings.json", data)
        result = ((data.get("chart") or {}).get("result") or [{}])[0]
        events = ((result.get("events") or {}).get("earnings") or {})
        for item in events.values():
            ts = item.get("date") or item.get("startdatetime")
            if ts:
                dates.add(datetime.fromtimestamp(int(ts), timezone.utc).date())
        coverage.append(
            {
                "feed": "earnings_calendar",
                "symbol": symbol,
                "source": chart_url,
                "rows": len(dates),
                "status": "ok" if dates else "empty_no_historical_events",
                "data_mode": "true_yahoo_chart_events_attempt",
            }
        )
    except Exception as exc:
        coverage.append({"feed": "earnings_calendar", "symbol": symbol, "source": chart_url, "rows": 0, "status": f"error:{exc}", "data_mode": "true_feed_failed"})
    return dates


def fetch_yahoo_options_snapshot(symbol: str, coverage: list[dict[str, Any]]) -> dict[str, Any]:
    url = f"https://query2.finance.yahoo.com/v7/finance/options/{urllib.parse.quote(symbol)}"
    try:
        data = http_json(url)
        write_json_cache(f"{symbol}_yahoo_options_snapshot.json", data)
        result = (((data.get("optionChain") or {}).get("result") or [{}])[0])
        options = (result.get("options") or [{}])[0]
        calls = options.get("calls") or []
        puts = options.get("puts") or []
        call_oi = sum(float(x.get("openInterest") or 0.0) for x in calls)
        put_oi = sum(float(x.get("openInterest") or 0.0) for x in puts)
        snapshot = {
            "available": True,
            "call_open_interest": call_oi,
            "put_open_interest": put_oi,
            "put_call_oi_ratio": put_oi / call_oi if call_oi > 0 else 0.0,
            "expiration_count": len(result.get("expirationDates") or []),
            "contract_count": len(calls) + len(puts),
        }
        coverage.append(
            {
                "feed": "options_chain_oi",
                "symbol": symbol,
                "source": url,
                "rows": snapshot["contract_count"],
                "status": "snapshot_only_not_used_for_historical_blind",
                "data_mode": "true_current_snapshot_no_historical_replay",
            }
        )
        return snapshot
    except Exception as exc:
        coverage.append({"feed": "options_chain_oi", "symbol": symbol, "source": url, "rows": 0, "status": f"error:{exc}", "data_mode": "true_feed_failed"})
        return {"available": False, "error": str(exc)}


def add_true_feed_features(
    df: pd.DataFrame,
    symbol: str,
    fomc_dates: set[date],
    cpi_dates: set[date],
    earnings_dates: set[date],
    options_snapshot: dict[str, Any],
) -> pd.DataFrame:
    out = df.copy()
    dates = out["timestamp"].dt.date
    out["fomc_event_window_true"] = dates.isin(fomc_dates).astype(float)
    out["cpi_event_window_true"] = dates.isin(cpi_dates).astype(float)
    out["earnings_event_window_true"] = dates.isin(earnings_dates).astype(float)
    out["true_event_risk"] = out[["fomc_event_window_true", "cpi_event_window_true", "earnings_event_window_true"]].max(axis=1)
    # Do not leak a current options snapshot into historical bars. The boolean
    # only audits availability; it is intentionally constant and non-predictive.
    out["options_gamma_snapshot_available"] = 1.0 if options_snapshot.get("available") else 0.0
    out["event_risk_proxy"] = (0.80 * out["event_risk_proxy"] + 0.20 * out["true_event_risk"]).clip(0.0, 1.0)
    return out.replace([float("inf"), float("-inf")], 0.0).fillna(0.0)


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
        "- 真实事件/期权数据只在可因果对齐时进入模型；当前期权快照不会回填历史盲测。",
        "",
        "## 数据覆盖",
        "",
    ]
    for row in summary["true_feed_coverage"]:
        label = row.get("feed") or row.get("source")
        sym = row.get("symbol", "GLOBAL")
        lines.append(f"- `{label}` `{sym}` rows=`{row.get('rows', 0)}` status=`{row.get('status')}` data_mode=`{row.get('data_mode')}`")
    lines.extend(["", "## 每个标的/方向最优路线", ""])
    for row in summary["selected_routes"]:
        lines.append(
            f"- `{row['symbol']}` `{row['side_policy']}` -> `{row['cadence']}` status=`{row['status']}`；"
            f"train={row['train_net_pnl_usd']} PF={row['train_profit_factor']} trades={row['train_trades']}；"
            f"val={row['validation_net_pnl_usd']} PF={row['validation_profit_factor']} trades={row['validation_trades']}；"
            f"test={row['test_net_pnl_usd']} PF={row['test_profit_factor']} trades={row['test_trades']}。"
        )
    lines.extend(["", "## 下一步", "", summary["next_action"]])
    return "\n".join(lines) + "\n"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)

    # Patch V1.5 module globals so all reused functions write V1.6 outputs and
    # train with the expanded true-feed feature list.
    v15.VERSION = VERSION
    v15.OUT_DIR = OUT_DIR
    v15.RAW_DIR = OUT_DIR / "raw_yahoo_chart"
    v15.FEATURES = FEATURES

    coverage: list[dict[str, Any]] = []
    datasets = v15.build_base_datasets(coverage)
    true_feed_coverage: list[dict[str, Any]] = []
    fomc_dates = fetch_fomc_dates(true_feed_coverage)
    cpi_dates = fetch_bls_cpi_release_dates(true_feed_coverage)
    earnings_by_symbol = {symbol: fetch_yahoo_earnings_dates(symbol, true_feed_coverage) for symbol in TARGET_SYMBOLS}
    options_by_symbol = {symbol: fetch_yahoo_options_snapshot(symbol, true_feed_coverage) for symbol in TARGET_SYMBOLS}

    summaries: list[dict[str, Any]] = []
    trades_all: list[dict[str, Any]] = []
    gates_all: list[dict[str, Any]] = []
    models: list[dict[str, Any]] = []

    for symbol in TARGET_SYMBOLS:
        for cadence in CADENCES:
            print(f"[{utc_now()}] V1.6 testing {symbol} {cadence} long/short", flush=True)
            df0 = datasets.get((symbol, cadence))
            if df0 is None or len(df0) < 90:
                coverage.append({"symbol": symbol, "cadence": cadence, "source": "target_route", "rows": 0, "status": "missing_or_low"})
                continue
            df = v15.add_specialist_features(df0, symbol, cadence, datasets)
            df = add_true_feed_features(df, symbol, fomc_dates, cpi_dates, earnings_by_symbol[symbol], options_by_symbol[symbol])
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
                        "features": ",".join(FEATURES),
                        "fomc_calendar_used": bool(fomc_dates),
                        "cpi_calendar_used": bool(cpi_dates),
                        "earnings_calendar_used": bool(earnings_by_symbol[symbol]),
                        "options_snapshot_available": bool(options_by_symbol[symbol].get("available")),
                        "options_snapshot_used_in_historical_blind": False,
                    }
                )
                for policy in v15.build_policies(symbol, cadence, side_policy):
                    trades, gates = v15.simulate(df, policy, model)
                    trades_all.extend(trades)
                    gates_all.extend(gates)
                    summaries.append(v15.summarize(policy, trades, model))

    selected = v15.select_best(summaries)
    selected_names = {r["policy_name"] for r in selected}
    selected_trades = [t for t in trades_all if t["policy_name"] in selected_names]
    candidates = [r for r in selected if r["status"] == "stock_v1_5_online_paper_candidate"]
    watchlist = [r for r in selected if r["status"] in {"validation_test_watchlist", "test_positive_watchlist"}]
    true_critical_coverage_ok = bool(fomc_dates) and bool(cpi_dates) and all(earnings_by_symbol.values()) and all(x.get("available") for x in options_by_symbol.values())
    deployment_allowed = bool(candidates) and true_critical_coverage_ok
    decision = "stock_v1_6_online_paper_ready" if deployment_allowed else ("stock_v1_6_data_blocked_watchlist" if watchlist else "stock_v1_6_blocked")

    png_path = OUT_DIR / "HFCD_Stock_V1_6_TrueEventOptionsFeed.png"
    figure_generated = v15.build_plot(selected, png_path)
    permission_rows = [
        {
            "symbol": r["symbol"],
            "cadence": r["cadence"],
            "side_policy": r["side_policy"],
            "allowed": bool(r["status"] == "stock_v1_5_online_paper_candidate") and true_critical_coverage_ok,
            "status": r["status"],
            "blocked_reason": "" if true_critical_coverage_ok else "missing_true_cpi_or_earnings_or_historical_options_feed",
            "train_pnl_usd": r["train_net_pnl_usd"],
            "validation_pnl_usd": r["validation_net_pnl_usd"],
            "test_pnl_usd": r["test_net_pnl_usd"],
            "test_profit_factor": r["test_profit_factor"],
        }
        for r in selected
    ]
    output_files = {
        "summary": str(OUT_DIR / "hfcd_stock_v1_6_summary.json"),
        "route_summary": str(OUT_DIR / "hfcd_stock_v1_6_route_summary.csv"),
        "selected_routes": str(OUT_DIR / "hfcd_stock_v1_6_selected_routes.csv"),
        "selected_trades": str(OUT_DIR / "hfcd_stock_v1_6_selected_trades.csv"),
        "gate_audit": str(OUT_DIR / "hfcd_stock_v1_6_gate_audit.csv"),
        "model_audit": str(OUT_DIR / "hfcd_stock_v1_6_model_audit.csv"),
        "data_coverage": str(OUT_DIR / "hfcd_stock_v1_6_data_coverage.csv"),
        "true_feed_coverage": str(OUT_DIR / "hfcd_stock_v1_6_true_feed_coverage.csv"),
        "permission_matrix": str(OUT_DIR / "hfcd_stock_v1_6_direction_permission_matrix.csv"),
        "report": str(OUT_DIR / "HFCD_Stock_V1_6_TrueEventOptionsFeed.md"),
        "figure": str(png_path),
    }
    summary = {
        "version": VERSION,
        "generated_at": utc_now(),
        "decision": decision,
        "promotion_status": "blocked_by_true_feed_coverage" if not deployment_allowed else "candidate_for_online_paper",
        "deployment_allowed": deployment_allowed,
        "online_or_broker_touched": False,
        "data_mode": "real_yahoo_intraday_real_fomc_calendar_attempted_cpi_earnings_options_feed_audited",
        "target_symbols": TARGET_SYMBOLS,
        "cadences": CADENCES,
        "side_policies": SIDE_POLICIES,
        "candidate_count": len(candidates),
        "watchlist_count": len(watchlist),
        "candidate_routes": candidates,
        "selected_routes": selected,
        "permission_matrix": permission_rows,
        "true_feed_coverage": true_feed_coverage,
        "quality_gates": {
            "train_validation_test_required": True,
            "forecast_edge_gate_used": True,
            "train_only_model_fit": True,
            "fomc_calendar_true_feed_used": bool(fomc_dates),
            "cpi_calendar_true_feed_used": bool(cpi_dates),
            "earnings_calendar_true_feed_used": all(bool(v) for v in earnings_by_symbol.values()),
            "options_historical_gamma_oi_true_feed_used": False,
            "options_snapshot_injected_into_history": False,
            "deployment_requires_true_critical_coverage": True,
            "figure_generated": figure_generated,
        },
        "output_files": output_files,
        "next_action": (
            "Do not deploy V1.6 until CPI release timestamps, historical earnings event dates, "
            "and historical options chain/OI/Gamma replay are available. Current online stock routes remain V1.4."
        ),
    }

    v15.write_csv(OUT_DIR / "hfcd_stock_v1_6_route_summary.csv", summaries)
    v15.write_csv(OUT_DIR / "hfcd_stock_v1_6_selected_routes.csv", selected)
    v15.write_csv(OUT_DIR / "hfcd_stock_v1_6_selected_trades.csv", selected_trades)
    v15.write_csv(OUT_DIR / "hfcd_stock_v1_6_gate_audit.csv", gates_all)
    v15.write_csv(OUT_DIR / "hfcd_stock_v1_6_model_audit.csv", models)
    v15.write_csv(OUT_DIR / "hfcd_stock_v1_6_data_coverage.csv", coverage)
    v15.write_csv(OUT_DIR / "hfcd_stock_v1_6_true_feed_coverage.csv", true_feed_coverage)
    v15.write_csv(OUT_DIR / "hfcd_stock_v1_6_direction_permission_matrix.csv", permission_rows)
    (OUT_DIR / "hfcd_stock_v1_6_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Stock_V1_6_TrueEventOptionsFeed.md").write_text(render_report(summary), encoding="utf-8")

    print(
        json.dumps(
            {
                "version": VERSION,
                "decision": decision,
                "deployment_allowed": deployment_allowed,
                "candidate_count": len(candidates),
                "watchlist_count": len(watchlist),
                "true_feed_coverage_ok": true_critical_coverage_ok,
                "selected_routes": [
                    {
                        "symbol": r["symbol"],
                        "cadence": r["cadence"],
                        "side_policy": r["side_policy"],
                        "status": r["status"],
                        "train_pnl": r["train_net_pnl_usd"],
                        "validation_pnl": r["validation_net_pnl_usd"],
                        "test_pnl": r["test_net_pnl_usd"],
                        "test_pf": r["test_profit_factor"],
                    }
                    for r in selected
                ],
                "output_dir": str(OUT_DIR),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
