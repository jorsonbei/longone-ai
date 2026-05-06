#!/usr/bin/env python3
"""
HFCD Trading V1.14 Gold Databento Probe

This script is intentionally metadata-first. It verifies local Databento
readiness and writes a gold futures data-acquisition plan without downloading
large billable historical data by default.
"""

from __future__ import annotations

import csv
import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any


VERSION = "HFCD_Trading_V1_14_GoldDatabentoProbe"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_14_gold_databento_probe"
DATASET = "GLBX.MDP3"


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def json_safe(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except TypeError:
        if isinstance(value, dict):
            return {str(k): json_safe(v) for k, v in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [json_safe(v) for v in value]
        return str(value)


def summarize_fields(fields: Any) -> dict[str, Any]:
    safe = json_safe(fields)
    if not isinstance(safe, list):
        return {"count": 0, "sample": safe}
    return {"count": len(safe), "sample": safe[:24]}


def summarize_symbology(resolved: Any) -> dict[str, Any]:
    safe = json_safe(resolved)
    result = safe.get("result", {}) if isinstance(safe, dict) else {}
    keys = sorted(result.keys()) if isinstance(result, dict) else []
    return {
        "resolved_symbol_count": len(keys),
        "sample_symbols": keys[:24],
        "not_found": safe.get("not_found", []) if isinstance(safe, dict) else [],
        "partial": safe.get("partial", []) if isinstance(safe, dict) else [],
        "status": safe.get("status", "") if isinstance(safe, dict) else "",
        "message": safe.get("message", "") if isinstance(safe, dict) else "",
    }


def print_summary(report: dict[str, Any]) -> None:
    dataset_range = report.get("dataset_range", {})
    schemas = report.get("schemas", [])
    print(
        json.dumps(
            {
                "version": report.get("version"),
                "dataset": report.get("dataset"),
                "key_loaded": report.get("key_loaded"),
                "databento_package": report.get("databento_package"),
                "metadata_status": report.get("metadata_status"),
                "dataset_start": dataset_range.get("start") if isinstance(dataset_range, dict) else "",
                "dataset_end": dataset_range.get("end") if isinstance(dataset_range, dict) else "",
                "schema_count": len(schemas) if isinstance(schemas, list) else 0,
                "errors_count": len(report.get("errors", [])),
                "out_dir": str(OUT_DIR),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    load_env_file(ROOT / ".env.local")
    load_env_file(ROOT / ".dev.vars")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    key_loaded = bool(os.environ.get("DATABENTO_API_KEY"))
    report: dict[str, Any] = {
        "version": VERSION,
        "mode": "metadata_probe_no_large_download",
        "dataset": DATASET,
        "key_loaded": key_loaded,
        "databento_package": "missing",
        "metadata_status": "not_checked",
        "errors": [],
    }

    rows: list[dict[str, Any]] = [
        {
            "sensor": "gc_contract_chain",
            "databento_dataset": DATASET,
            "schema_or_stype": "definition + parent symbology GC.FUT/MGC.FUT",
            "purpose": "黄金期货真实合约链、到期日、合约属性。",
            "status": "pending_probe",
        },
        {
            "sensor": "gc_daily_ohlcv",
            "databento_dataset": DATASET,
            "schema_or_stype": "ohlcv-1d",
            "purpose": "日线价格、成交量、连续合约与真实合约回放。",
            "status": "pending_probe",
        },
        {
            "sensor": "gc_daily_open_interest",
            "databento_dataset": DATASET,
            "schema_or_stype": "statistics/open_interest if available",
            "purpose": "替代 CFTC 周度代理，补每日 COMEX OI。",
            "status": "pending_probe",
        },
        {
            "sensor": "gc_term_structure_roll_yield",
            "databento_dataset": DATASET,
            "schema_or_stype": "definition + ohlcv-1d across expiries",
            "purpose": "期限结构、basis、roll yield、换月风险。",
            "status": "pending_probe",
        },
        {
            "sensor": "gc_execution_cavity",
            "databento_dataset": DATASET,
            "schema_or_stype": "bbo-1s/mbp-1 or similar book schema",
            "purpose": "买卖价差、滑点、盘口腔体，用于执行过滤。",
            "status": "pending_probe",
        },
    ]

    try:
        import databento as db  # type: ignore

        report["databento_package"] = getattr(db, "__version__", "installed")
    except Exception as exc:  # pragma: no cover - local environment guard
        report["errors"].append(f"databento_import_failed: {exc}")
        report["metadata_status"] = "package_missing"
        write_outputs(report, rows)
        return 2

    if not key_loaded:
        report["metadata_status"] = "missing_databento_api_key"
        report["next_action"] = "Put DATABENTO_API_KEY in .env.local, then rerun npm run trading:v1.14:gold-databento."
        write_outputs(report, rows)
        print_summary(report)
        return 0

    try:
        import databento as db  # type: ignore

        client = db.Historical(key=os.environ["DATABENTO_API_KEY"])
        dataset_range = client.metadata.get_dataset_range(DATASET)
        schemas = client.metadata.list_schemas(DATASET)
        report["dataset_range"] = json_safe(dataset_range)
        report["schemas"] = json_safe(schemas)
        report["metadata_status"] = "metadata_probe_pass"

        # Small metadata checks only. These do not download market history.
        yesterday = date.today() - timedelta(days=1)
        start = (yesterday - timedelta(days=7)).isoformat()
        end = yesterday.isoformat()
        for schema in ["definition", "ohlcv-1d", "statistics", "bbo-1s", "mbp-1"]:
            if schema not in schemas:
                continue
            try:
                fields = client.metadata.list_fields(schema=schema, encoding="dbn")
                report[f"fields_{schema}"] = summarize_fields(fields)
            except Exception as exc:
                report["errors"].append(f"list_fields_{schema}_failed: {exc}")

        for parent in ["GC.FUT", "MGC.FUT"]:
            try:
                resolved = client.symbology.resolve(
                    dataset=DATASET,
                    symbols=[parent],
                    stype_in="parent",
                    stype_out="instrument_id",
                    start_date=start,
                    end_date=end,
                )
                report[f"symbology_{parent}"] = summarize_symbology(resolved)
            except Exception as exc:
                report["errors"].append(f"symbology_{parent}_failed: {exc}")

        available = set(schemas)
        for row in rows:
            schema = row["schema_or_stype"]
            if "ohlcv-1d" in schema and "ohlcv-1d" in available:
                row["status"] = "schema_available_metadata_only"
            elif "definition" in schema and "definition" in available:
                row["status"] = "schema_available_metadata_only"
            elif ("bbo-1s" in schema and "bbo-1s" in available) or ("mbp-1" in schema and "mbp-1" in available):
                row["status"] = "schema_available_metadata_only"
            elif "statistics" in schema and "statistics" in available:
                row["status"] = "schema_available_metadata_only"
            else:
                row["status"] = "schema_needs_confirmation"
    except Exception as exc:
        report["metadata_status"] = "metadata_probe_failed"
        report["errors"].append(str(exc))

    write_outputs(report, rows)
    print_summary(report)
    return 0


def write_outputs(report: dict[str, Any], rows: list[dict[str, Any]]) -> None:
    (OUT_DIR / "hfcd_trading_v1_14_gold_databento_probe.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    write_csv(OUT_DIR / "hfcd_trading_v1_14_gold_databento_requirements.csv", rows)
    md = f"""# {VERSION}

## 定位

本轮只做 Databento 黄金期货接入探针，不下载大规模付费历史数据，不推线上。

## 当前状态

- Databento Python 包：{report.get("databento_package")}
- API key 是否已从本地环境加载：{"是" if report.get("key_loaded") else "否"}
- 元数据探针状态：{report.get("metadata_status")}
- 数据集：{DATASET}

## 黄金交易还缺什么

| 传感器 | Databento 目标 | 用途 | 状态 |
|---|---|---|---|
{chr(10).join(f"| {row['sensor']} | {row['schema_or_stype']} | {row['purpose']} | {row['status']} |" for row in rows)}

## 结论

- GLD/GLDM 招股书是基金结构文件，不是交易信号。
- FRED/WGC/CFTC 已经补了宏观、ETF flow 和周度 COMEX OI 代理。
- Databento 下一步要补的是 GC/MGC 合约链、每日价格、每日 OI、期限结构、roll yield 和执行腔体。
- 在确认成本前，不应直接拉多年 L2 或 tick 数据。
"""
    (OUT_DIR / "HFCD_Trading_V1_14_GoldDatabentoProbe.md").write_text(md, encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
