#!/usr/bin/env python3
"""HFCD Trading V2.18: BTC property/maker forward daemon.

Runs the V2.16 BTC property/maker forward shadow repeatedly so it can be
scheduled every 15 minutes. It intentionally remains separate from V2.13 main
forward ledger and does not modify online pages or place real orders.
"""

from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


VERSION = "HFCD_Trading_V2_18_BTCPropertyMakerForwardDaemon"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v2_18_btc_property_maker_forward_daemon"
V16_PATH = ROOT / "scripts" / "hfcd_trading_v2_16_btc_property_maker_forward_shadow.py"
V16_OUT = ROOT / "outputs" / "hfcd_trading_v2_16_btc_property_maker_forward_shadow"


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def append_csv(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    exists = path.exists() and path.stat().st_size > 0
    with path.open("a", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(row.keys()))
        if not exists:
            writer.writeheader()
        writer.writerow(row)


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def run_v16(v16: Any, liquidation_seconds: int) -> dict[str, Any]:
    original_argv = sys.argv[:]
    try:
        sys.argv = [
            str(V16_PATH),
            "--liquidation-seconds",
            str(liquidation_seconds),
        ]
        v16.main()
    finally:
        sys.argv = original_argv
    return read_json(V16_OUT / "hfcd_trading_v2_16_summary.json")


def cycle_row(cycle: int, status: str, started: datetime, finished: datetime, summary: dict[str, Any], error: str = "") -> dict[str, Any]:
    latest_events = summary.get("latest_events", []) if summary else []
    latest_decisions = summary.get("latest_decisions", []) if summary else []
    liquidation = summary.get("liquidation_status", {}) if summary else {}
    state = summary.get("state", {}) if summary else {}
    positions = state.get("positions", {}) if isinstance(state, dict) else {}
    realized = state.get("realized_pnl_usd", {}) if isinstance(state, dict) else {}
    return {
        "cycle": cycle,
        "started_at": iso(started),
        "finished_at": iso(finished),
        "status": status,
        "error": error,
        "liquidation_events": liquidation.get("events", 0),
        "latest_event_count": len(latest_events),
        "latest_decision_count": len(latest_decisions),
        "open_positions": len(positions),
        "btc_baseline_realized_pnl": realized.get("BTCUSDT:baseline", 0.0),
        "btc_property_realized_pnl": realized.get("BTCUSDT:property_vector", 0.0),
        "btc_maker_realized_pnl": realized.get("BTCUSDT:maker_cost", 0.0),
        "eth_baseline_realized_pnl": realized.get("ETHUSDT:baseline", 0.0),
        "v16_summary_path": str(V16_OUT / "hfcd_trading_v2_16_summary.json"),
    }


def daily_health(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    buckets: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        day = str(row["finished_at"])[:10]
        buckets.setdefault(day, []).append(row)
    out: list[dict[str, Any]] = []
    for day, items in sorted(buckets.items()):
        last = items[-1]
        out.append({
            "date": day,
            "cycles": len(items),
            "ok_cycles": sum(1 for x in items if x["status"] == "ok"),
            "failed_cycles": sum(1 for x in items if x["status"] != "ok"),
            "liquidation_events": sum(int(x.get("liquidation_events", 0) or 0) for x in items),
            "last_open_positions": last["open_positions"],
            "last_btc_baseline_realized_pnl": last["btc_baseline_realized_pnl"],
            "last_btc_property_realized_pnl": last["btc_property_realized_pnl"],
            "last_btc_maker_realized_pnl": last["btc_maker_realized_pnl"],
            "last_eth_baseline_realized_pnl": last["eth_baseline_realized_pnl"],
        })
    return out


def render_report(summary: dict[str, Any]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        "- V2.18 是 V2.16 的定时化外壳，目标是积累 BTC property/maker forward shadow 样本。",
        "- 不替代 V2.13 主账本，不改线上页面，不下真实订单。",
        f"- 本轮 cycles：`{summary['cycles']}`，interval_minutes：`{summary['interval_minutes']}`。",
        f"- 状态：`{summary['status']}`。",
        "",
        "## 输出",
        "",
        f"- Cycle audit: `{summary['files']['cycle_audit']}`",
        f"- Daily health: `{summary['files']['daily_health']}`",
        "",
        "## 使用",
        "",
        "可以用系统定时器或 cron 每 15 分钟运行一次 package 命令。当前脚本默认一次 cycle，用于安全验证。",
    ]
    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=VERSION)
    parser.add_argument("--cycles", type=int, default=1)
    parser.add_argument("--interval-minutes", type=float, default=15.0)
    parser.add_argument("--liquidation-seconds", type=int, default=8)
    parser.add_argument("--no-sleep", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    v16 = load_module("hfcd_v2_16_for_v18", V16_PATH)
    cycle_rows: list[dict[str, Any]] = []
    for cycle in range(1, max(1, args.cycles) + 1):
        started = now_utc()
        try:
            summary = run_v16(v16, args.liquidation_seconds)
            status = "ok"
            error = ""
        except Exception as exc:  # noqa: BLE001
            summary = {}
            status = "failed"
            error = str(exc)
        finished = now_utc()
        row = cycle_row(cycle, status, started, finished, summary, error)
        cycle_rows.append(row)
        append_csv(OUT_DIR / "hfcd_trading_v2_18_cycle_audit.csv", row)
        if cycle < args.cycles and not args.no_sleep:
            time.sleep(max(0.0, args.interval_minutes) * 60)

    existing_rows: list[dict[str, Any]] = []
    audit_path = OUT_DIR / "hfcd_trading_v2_18_cycle_audit.csv"
    if audit_path.exists() and audit_path.stat().st_size > 0:
        with audit_path.open("r", encoding="utf-8", newline="") as fh:
            existing_rows = list(csv.DictReader(fh))
    health = daily_health(existing_rows)
    write_csv(OUT_DIR / "hfcd_trading_v2_18_daily_health.csv", health)

    summary = {
        "version": VERSION,
        "created_at": iso(now_utc()),
        "status": "btc_property_maker_forward_daemon_completed" if all(r["status"] == "ok" for r in cycle_rows) else "btc_property_maker_forward_daemon_has_failures",
        "cycles": args.cycles,
        "interval_minutes": args.interval_minutes,
        "no_sleep": args.no_sleep,
        "no_real_orders": True,
        "no_online_page_change": True,
        "does_not_modify_v2_13_main_ledger": True,
        "latest_cycles": cycle_rows,
        "daily_health": health,
        "files": {
            "cycle_audit": str(OUT_DIR / "hfcd_trading_v2_18_cycle_audit.csv"),
            "daily_health": str(OUT_DIR / "hfcd_trading_v2_18_daily_health.csv"),
            "summary": str(OUT_DIR / "hfcd_trading_v2_18_summary.json"),
            "report": str(OUT_DIR / "HFCD_Trading_V2_18_BTCPropertyMakerForwardDaemon.md"),
        },
    }
    (OUT_DIR / "hfcd_trading_v2_18_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Trading_V2_18_BTCPropertyMakerForwardDaemon.md").write_text(render_report(summary), encoding="utf-8")

    print(json.dumps({
        "version": VERSION,
        "status": summary["status"],
        "cycles": args.cycles,
        "output_dir": str(OUT_DIR),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
