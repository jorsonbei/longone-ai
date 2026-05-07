#!/usr/bin/env python3
"""HFCD Trading V2.19: liquidation-history readiness audit.

V2.19 should rerun liquidation_event blind only after real historical
liquidation data exists. This audit refuses to fabricate liquidation history and
produces a clear readiness report.
"""

from __future__ import annotations

import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd


VERSION = "HFCD_Trading_V2_19_LiquidationHistoryReadiness"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v2_19_liquidation_history_readiness"
LIQ_PATHS = [
    ROOT / "outputs" / "hfcd_trading_v2_4_crypto_true_sensor_history" / "hfcd_trading_v2_4_liquidation_history.csv",
    ROOT / "data" / "crypto_liquidation_history.csv",
    ROOT / "training" / "crypto_liquidation_history.csv",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def inspect_path(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {
            "path": str(path),
            "exists": False,
            "rows": 0,
            "symbols": "",
            "start_ts": "",
            "end_ts": "",
            "status": "missing",
        }
    try:
        df = pd.read_csv(path)
    except Exception as exc:  # noqa: BLE001
        return {
            "path": str(path),
            "exists": True,
            "rows": 0,
            "symbols": "",
            "start_ts": "",
            "end_ts": "",
            "status": f"read_failed:{exc}",
        }
    if df.empty:
        return {
            "path": str(path),
            "exists": True,
            "rows": 0,
            "symbols": "",
            "start_ts": "",
            "end_ts": "",
            "status": "empty",
        }
    ts_col = "ts" if "ts" in df.columns else ("timestamp" if "timestamp" in df.columns else "")
    if ts_col:
        ts = pd.to_datetime(df[ts_col], utc=True, errors="coerce").dropna()
        start = ts.min().isoformat().replace("+00:00", "Z") if not ts.empty else ""
        end = ts.max().isoformat().replace("+00:00", "Z") if not ts.empty else ""
    else:
        start = ""
        end = ""
    return {
        "path": str(path),
        "exists": True,
        "rows": int(len(df)),
        "symbols": ",".join(sorted(str(x) for x in df.get("symbol", pd.Series(dtype=str)).dropna().unique())),
        "start_ts": start,
        "end_ts": end,
        "status": "ready" if len(df) > 0 and ts_col else "partial_no_timestamp",
    }


def render_report(summary: dict[str, Any]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 是否可以重跑 liquidation_event blind：`{summary['ready_to_rerun_liquidation_blind']}`。",
        f"- 状态：`{summary['status']}`。",
        "",
        "## 本地检查",
        "",
        "| Path | Rows | Status |",
        "|---|---:|---|",
    ]
    for row in summary["audits"]:
        lines.append(f"| `{row['path']}` | {row['rows']} | `{row['status']}` |")
    lines.extend([
        "",
        "## 下一步",
        "",
        "需要 CoinGlass、Coinalyze、Tardis 或交易所导出的真实历史强平数据，至少包含 `ts,symbol,side,price,qty,notional_usd,source`。",
        "当前不能用空文件重跑 liquidation_event，否则会得到虚假的零交易结论。",
    ])
    return "\n".join(lines) + "\n"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    audits = [inspect_path(path) for path in LIQ_PATHS]
    ready = any(row["status"] == "ready" and row["rows"] > 0 for row in audits)
    summary = {
        "version": VERSION,
        "created_at": now_iso(),
        "status": "liquidation_history_ready" if ready else "blocked_missing_real_liquidation_history",
        "ready_to_rerun_liquidation_blind": ready,
        "no_fake_liquidation_data": True,
        "audits": audits,
        "files": {
            "coverage": str(OUT_DIR / "hfcd_trading_v2_19_liquidation_history_coverage.csv"),
            "summary": str(OUT_DIR / "hfcd_trading_v2_19_summary.json"),
            "report": str(OUT_DIR / "HFCD_Trading_V2_19_LiquidationHistoryReadiness.md"),
        },
    }
    write_csv(OUT_DIR / "hfcd_trading_v2_19_liquidation_history_coverage.csv", audits)
    (OUT_DIR / "hfcd_trading_v2_19_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Trading_V2_19_LiquidationHistoryReadiness.md").write_text(render_report(summary), encoding="utf-8")
    print(json.dumps({
        "version": VERSION,
        "status": summary["status"],
        "ready_to_rerun_liquidation_blind": ready,
        "output_dir": str(OUT_DIR),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
