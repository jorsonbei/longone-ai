#!/usr/bin/env python3
"""
HFCD Trading V1.17 Gold Risk/L2/Margin Probe

This stage handles two hard gaps after V1.16:
- Try CME SPAN public locations for margin files and write machine-readable
  source status.
- Use Databento trial credit conservatively: fetch a bounded GC mbp-10 sample
  to validate multi-level order-book depth features without pulling large L2
  history by default.

It does not deploy anything and it does not attempt broad paid downloads.
"""

from __future__ import annotations

import csv
import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import requests
import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_17_GoldRiskL2MarginProbe"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_17_gold_risk_l2_margin"
LOCAL_DATA_DIR = Path("/Users/beijisheng/Desktop/420/数据")
DATASET = "GLBX.MDP3"

SPAN_URLS = [
    "https://datamine.new.cmegroup.com/catalog?category=FE32",
    "https://www.cmegroup.com/ftp/span/",
    "https://www.cmegroup.com/ftp/span/data/cme/",
    "https://www.cmegroup.com/ftp/pub/span/",
    "https://www.cmegroup.com/ftp/pub/span/data/cme/",
    "ftp://ftp.cmegroup.com/pub/span/",
    "ftp://ftp.cmegroup.com/pub/span/data/cme/",
]

DEFAULT_L2_SYMBOL = os.environ.get("HFCD_GOLD_L2_SYMBOL", "GCM6")
DEFAULT_L2_START = os.environ.get("HFCD_GOLD_L2_START", "2026-05-01T13:30")
DEFAULT_L2_END = os.environ.get("HFCD_GOLD_L2_END", "2026-05-01T13:35")
SPAN_FILE_RE = re.compile(r"""href=["']?([^"' >]+?\.(?:zip|dat|spn|csv))["']?""", re.IGNORECASE)
CME_DATAMINE_DOWNLOAD_URL = "https://datamine.new.cmegroup.com/cme/api/v2/download"


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames: list[str] = []
    for row in rows:
        for key in row.keys():
            if key not in fieldnames:
                fieldnames.append(key)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def df_to_csv(df: pd.DataFrame, path: Path) -> int:
    if df is None or df.empty:
        path.write_text("", encoding="utf-8")
        return 0
    df.reset_index().to_csv(path, index=False)
    return len(df)


def probe_span_sources() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for url in SPAN_URLS:
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(request, timeout=20) as response:
                sample = response.read(1500).decode("utf-8", errors="replace")
                rows.append(
                    {
                        "source": url,
                        "status": "accessible",
                        "http_status": getattr(response, "status", ""),
                        "content_type": response.headers.get("content-type", ""),
                        "sample": sample.replace("\n", " ")[:240],
                        "candidate_files": ";".join(SPAN_FILE_RE.findall(sample)[:20]),
                        "machine_readable": bool(SPAN_FILE_RE.search(sample)),
                        "next_action": "parse_directory_or_download_latest_dat_zip",
                    }
                )
        except urllib.error.HTTPError as exc:
            try:
                sample = exc.read(500).decode("utf-8", errors="replace")
            except Exception:
                sample = ""
            rows.append(
                {
                    "source": url,
                    "status": "blocked_or_unavailable",
                    "http_status": exc.code,
                    "content_type": exc.headers.get("content-type", ""),
                    "sample": sample.replace("\n", " ")[:240],
                    "candidate_files": "",
                    "machine_readable": False,
                    "error": f"HTTPError: {exc}",
                    "next_action": "use CME DataMine/CORE/SPAN export or broker margin CSV",
                }
            )
        except Exception as exc:
            rows.append(
                {
                    "source": url,
                    "status": "blocked_or_unavailable",
                    "http_status": "",
                    "content_type": "",
                    "sample": "",
                    "candidate_files": "",
                    "machine_readable": False,
                    "error": f"{type(exc).__name__}: {exc}",
                    "next_action": "use CME DataMine/CORE/SPAN export or broker margin CSV",
                }
            )
    return rows


def span_candidate_dates() -> list[str]:
    configured = os.environ.get("HFCD_SPAN_DATES", "").strip()
    if configured:
        return [part.strip().replace("-", "") for part in configured.split(",") if part.strip()]
    today = datetime.utcnow().date()
    return [(today - timedelta(days=offset)).strftime("%Y%m%d") for offset in range(0, 10)]


def read_datamine_file_id_templates() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    template_rows: list[dict[str, Any]] = []
    candidate_rows: list[dict[str, Any]] = []
    dates = span_candidate_dates()
    for path in sorted(LOCAL_DATA_DIR.glob("*SPAN*api-file-ids.csv")):
        try:
            df = pd.read_csv(path)
        except Exception as exc:
            template_rows.append(
                {
                    "source_file": str(path),
                    "name": "",
                    "file_id_template": "",
                    "source_group": "unknown",
                    "status": f"read_failed: {type(exc).__name__}",
                }
            )
            continue
        for row in df.to_dict("records"):
            file_id_template = str(row.get("file_id", "")).strip()
            name = str(row.get("name", "")).strip()
            source_group = "cme_group" if "All CME Group" in path.name else "partner_exchange"
            is_gold_relevant = source_group == "cme_group"
            template_rows.append(
                {
                    "source_file": str(path),
                    "name": name,
                    "file_id_template": file_id_template,
                    "source_group": source_group,
                    "gold_relevant": is_gold_relevant,
                    "status": "template_loaded" if file_id_template else "missing_file_id",
                }
            )
            if not file_id_template or "{YYYYMMDD}" not in file_id_template:
                continue
            for date in dates:
                fid = file_id_template.replace("{YYYYMMDD}", date)
                candidate_rows.append(
                    {
                        "source_file": str(path),
                        "source_group": source_group,
                        "name": name,
                        "date": date,
                        "fid": fid,
                        "download_url": f"{CME_DATAMINE_DOWNLOAD_URL}?fid={fid}",
                        "gold_relevant": is_gold_relevant,
                    }
                )
    return template_rows, candidate_rows


def probe_datamine_direct_download(candidate_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for candidate in [row for row in candidate_rows if row.get("gold_relevant")][:5]:
        url = str(candidate["download_url"])
        try:
            response = requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
            sample = response.content[:160]
            rows.append(
                {
                    "fid": candidate["fid"],
                    "date": candidate["date"],
                    "download_url": url,
                    "http_status": response.status_code,
                    "content_type": response.headers.get("content-type", ""),
                    "content_length": len(response.content),
                    "looks_like_file": response.status_code == 200 and len(response.content) > 1000,
                    "sample": sample.decode("utf-8", errors="replace").replace("\n", " "),
                }
            )
        except Exception as exc:
            rows.append(
                {
                    "fid": candidate["fid"],
                    "date": candidate["date"],
                    "download_url": url,
                    "http_status": "",
                    "content_type": "",
                    "content_length": 0,
                    "looks_like_file": False,
                    "error": f"{type(exc).__name__}: {exc}",
                    "sample": "",
                }
            )
    return rows


def fetch_databento_mbp10() -> dict[str, Any]:
    report: dict[str, Any] = {
        "key_loaded": bool(os.environ.get("DATABENTO_API_KEY")),
        "dataset": DATASET,
        "symbol": DEFAULT_L2_SYMBOL,
        "schema": "mbp-10",
        "start": DEFAULT_L2_START,
        "end": DEFAULT_L2_END,
        "rows": 0,
        "status": "not_started",
    }
    if not report["key_loaded"]:
        report["status"] = "missing_databento_api_key"
        return report

    schema_used = "mbp-10"
    try:
        import databento as db  # type: ignore

        client = db.Historical(key=os.environ["DATABENTO_API_KEY"])
        try:
            data = client.timeseries.get_range(
                dataset=DATASET,
                schema=schema_used,
                symbols=[DEFAULT_L2_SYMBOL],
                stype_in="raw_symbol",
                start=DEFAULT_L2_START,
                end=DEFAULT_L2_END,
            )
        except Exception:
            # Some trial accounts lack mbp-10 entitlement. Fall back to BBO so the
            # probe still produces an execution-cavity artifact.
            schema_used = "bbo-1s"
            data = client.timeseries.get_range(
                dataset=DATASET,
                schema=schema_used,
                symbols=[DEFAULT_L2_SYMBOL],
                stype_in="raw_symbol",
                start=DEFAULT_L2_START,
                end=DEFAULT_L2_END,
            )
        df = data.to_df()
        if not df.empty:
            df = df.copy()
            if "ask_px_00" in df.columns and "bid_px_00" in df.columns:
                df["spread_top"] = df["ask_px_00"] - df["bid_px_00"]
            bid_size_cols = [col for col in df.columns if col.startswith("bid_sz_")]
            ask_size_cols = [col for col in df.columns if col.startswith("ask_sz_")]
            if bid_size_cols and ask_size_cols:
                df["book_depth_bid_10"] = df[bid_size_cols].sum(axis=1)
                df["book_depth_ask_10"] = df[ask_size_cols].sum(axis=1)
                df["book_depth_total_10"] = df["book_depth_bid_10"] + df["book_depth_ask_10"]
                denom = df["book_depth_total_10"].astype(float).to_numpy()
                numer = df["book_depth_bid_10"].astype(float).to_numpy() - df["book_depth_ask_10"].astype(float).to_numpy()
                df["book_imbalance_10"] = np.where(denom > 0, numer / denom, np.nan)
            if "ask_sz_00" in df.columns and "bid_sz_00" in df.columns and "book_depth_total_10" not in df.columns:
                df["book_depth_bid_10"] = df["bid_sz_00"]
                df["book_depth_ask_10"] = df["ask_sz_00"]
                df["book_depth_total_10"] = df["book_depth_bid_10"] + df["book_depth_ask_10"]
                denom = df["book_depth_total_10"].astype(float).to_numpy()
                numer = df["book_depth_bid_10"].astype(float).to_numpy() - df["book_depth_ask_10"].astype(float).to_numpy()
                df["book_imbalance_10"] = np.where(denom > 0, numer / denom, np.nan)
            if "spread_top" in df.columns and "book_depth_total_10" in df.columns:
                df["cavity_score_proxy"] = np.log1p(df["book_depth_total_10"].astype(float)) / (1.0 + df["spread_top"].abs())
        rows = df_to_csv(df, OUT_DIR / "hfcd_trading_v1_17_gc_mbp10_l2_sample.csv")
        report.update(
            {
                "rows": rows,
                "schema": schema_used,
                "status": f"downloaded_bounded_{schema_used}_sample" if rows else "empty_result",
                "avg_spread_top": float(df["spread_top"].mean()) if rows and "spread_top" in df.columns else None,
                "avg_depth_total_10": float(df["book_depth_total_10"].mean()) if rows and "book_depth_total_10" in df.columns else None,
                "avg_book_imbalance_10": float(df["book_imbalance_10"].mean()) if rows and "book_imbalance_10" in df.columns else None,
                "avg_cavity_score_proxy": float(df["cavity_score_proxy"].mean()) if rows and "cavity_score_proxy" in df.columns else None,
            }
        )
    except Exception as exc:
        report["status"] = f"failed: {type(exc).__name__}"
        report["error"] = str(exc)
    return report


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    load_env_file(ROOT / ".env.local")
    load_env_file(ROOT / ".dev.vars")

    span_rows = probe_span_sources()
    write_csv(OUT_DIR / "hfcd_trading_v1_17_cme_span_source_status.csv", span_rows)
    candidate_rows = []
    for row in span_rows:
        for candidate in str(row.get("candidate_files", "")).split(";"):
            if candidate:
                candidate_rows.append({"source": row["source"], "candidate_file": candidate})
    write_csv(OUT_DIR / "hfcd_trading_v1_17_cme_span_candidate_files.csv", candidate_rows)

    datamine_template_rows, datamine_candidate_rows = read_datamine_file_id_templates()
    write_csv(OUT_DIR / "hfcd_trading_v1_17_datamine_span_file_id_templates.csv", datamine_template_rows)
    write_csv(OUT_DIR / "hfcd_trading_v1_17_datamine_span_fid_candidates.csv", datamine_candidate_rows)
    datamine_direct_probe_rows = probe_datamine_direct_download(datamine_candidate_rows)
    write_csv(OUT_DIR / "hfcd_trading_v1_17_datamine_direct_download_probe.csv", datamine_direct_probe_rows)

    l2_report = fetch_databento_mbp10()

    summary = {
        "version": VERSION,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "mode": "bounded_probe_not_deployed",
        "span_accessible_sources": sum(1 for row in span_rows if row["status"] == "accessible"),
        "span_blocked_sources": sum(1 for row in span_rows if row["status"] != "accessible"),
        "span_machine_readable_sources": sum(1 for row in span_rows if row.get("machine_readable")),
        "span_candidate_files": len(candidate_rows),
        "datamine_file_id_templates": len(datamine_template_rows),
        "datamine_fid_candidates": len(datamine_candidate_rows),
        "datamine_gold_fid_candidates": sum(1 for row in datamine_candidate_rows if row.get("gold_relevant")),
        "datamine_credentials_loaded": bool(os.environ.get("CME_DATAMINE_API_ID") and os.environ.get("CME_DATAMINE_API_PASSWORD")),
        "datamine_direct_download_probe": {
            "attempts": len(datamine_direct_probe_rows),
            "file_like_success": sum(1 for row in datamine_direct_probe_rows if row.get("looks_like_file")),
            "status_codes": sorted({str(row.get("http_status")) for row in datamine_direct_probe_rows}),
        },
        "databento_l2": l2_report,
        "decision": {
            "databento_trial": "usable_for_bounded_l2_samples_and_controlled_history_windows",
            "cme_span_public_ftp": "not_machine_accessible_from_current_environment" if not any(row["status"] == "accessible" for row in span_rows) else "partially_accessible",
            "datamine_file_ids": "local_api_file_id_csv_loaded_and_fid_candidates_generated" if datamine_candidate_rows else "missing_file_id_csv",
            "margin_history": "download_ready_after_CME_DATAMINE_API_ID_and_CME_DATAMINE_API_PASSWORD_are_available",
        },
    }
    (OUT_DIR / "hfcd_trading_v1_17_gold_risk_l2_margin_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    md = f"""# {VERSION}

## 本轮目标

验证两件事：

1. CME SPAN 公开 FTP/HTTP 目录是否能自动抓取黄金保证金文件。
2. Databento $120 试用额度下，能否低成本拉取黄金多档盘口 L2 样本。

## 结果

- CME SPAN 公开目录可访问源数量：{summary['span_accessible_sources']}
- CME SPAN 被阻挡/不可用源数量：{summary['span_blocked_sources']}
- CME SPAN 可机器解析文件数量：{summary['span_candidate_files']}
- 本地 DataMine file_id 模板数量：{summary['datamine_file_id_templates']}
- 已生成 DataMine fid 候选数量：{summary['datamine_fid_candidates']}
- 其中 CME Group 黄金相关候选数量：{summary['datamine_gold_fid_candidates']}
- CME DataMine API 认证是否已配置：{summary['datamine_credentials_loaded']}
- DataMine 直接下载探测成功文件数：{summary['datamine_direct_download_probe']['file_like_success']} / {summary['datamine_direct_download_probe']['attempts']}
- DataMine 直接下载 HTTP 状态：{', '.join(summary['datamine_direct_download_probe']['status_codes'])}
- Databento L2 schema：`{l2_report.get('schema')}`
- Databento L2 符号：`{DEFAULT_L2_SYMBOL}`
- Databento L2 时间窗：`{DEFAULT_L2_START}` → `{DEFAULT_L2_END}`
- Databento L2 行数：{l2_report.get('rows')}
- 平均顶层价差：{l2_report.get('avg_spread_top')}
- 平均 10 档深度：{l2_report.get('avg_depth_total_10')}
- 平均 10 档盘口不平衡：{l2_report.get('avg_book_imbalance_10')}

## 判断

Databento 可以作为黄金盘口腔体的正式数据源，但默认必须用明确时间窗控制下载，避免试用额度被大范围 L2 消耗。

CME SPAN 公开目录在当前环境下无法作为稳定自动源。你放入的 `api-file-ids.csv` 已经解决了“文件 ID 怎么构造”的问题；剩余硬条件是 CME DataMine API ID/Password，或从网页下载后的实际 `.dat/.zip/.spn` 文件。

## 输出文件

- `hfcd_trading_v1_17_cme_span_source_status.csv`
- `hfcd_trading_v1_17_cme_span_candidate_files.csv`
- `hfcd_trading_v1_17_datamine_span_file_id_templates.csv`
- `hfcd_trading_v1_17_datamine_span_fid_candidates.csv`
- `hfcd_trading_v1_17_datamine_direct_download_probe.csv`
- `hfcd_trading_v1_17_gc_mbp10_l2_sample.csv`
- `hfcd_trading_v1_17_gold_risk_l2_margin_summary.json`
"""
    (OUT_DIR / "HFCD_Trading_V1_17_GoldRiskL2MarginProbe.md").write_text(md, encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"out_dir={OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
