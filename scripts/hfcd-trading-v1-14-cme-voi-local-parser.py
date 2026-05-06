#!/usr/bin/env python3
"""
Parse a local CME-style VOI Details spreadsheet into HFCD sensor tables.

The spreadsheet name is usually generic (VoiDetailsForProduct.xls). In this
workflow it was downloaded from CME Group's Gold Volume & OI page, so it is
treated as confirmed CME Gold VOI provenance. It extracts:
- futures month volume/open interest table
- options call/put strike volume/open interest table
- compact summary for the gold/futures sensor ledger
"""

from __future__ import annotations

import csv
import json
import re
from pathlib import Path
from typing import Any

import pandas as pd


VERSION = "HFCD_Trading_V1_14_CME_VOI_LocalParser"
ROOT = Path.cwd()
DEFAULT_INPUT = Path("/Users/beijisheng/Desktop/420/数据/VoiDetailsForProduct.xls")
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_14_cme_voi_local_file"
SOURCE_URL = "https://www.cmegroup.com/markets/metals/precious/gold.volume.html"


FUTURE_COLUMNS = [
    "month",
    "globex",
    "open_outcry",
    "clear_port",
    "total_volume",
    "block_trades",
    "efp",
    "efr",
    "tas",
    "deliveries",
    "open_interest_at_close",
    "open_interest_change",
]

OPTION_COLUMNS = [
    "strike",
    "globex",
    "open_outcry",
    "clear_port",
    "total_volume",
    "block_trades",
    "eoo",
    "exercises",
    "open_interest_at_close",
    "open_interest_change",
]


def clean_num(value: Any) -> int:
    text = str(value).strip().replace(",", "")
    if not text or text.lower() == "nan":
        return 0
    try:
        return int(float(text))
    except ValueError:
        return 0


def clean_text(value: Any) -> str:
    return str(value).strip()


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def parse_voi(path: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    df = pd.read_excel(path, header=None, dtype=str).fillna("")
    futures: list[dict[str, Any]] = []
    options: list[dict[str, Any]] = []
    sections: list[dict[str, Any]] = []

    mode = ""
    option_type = ""
    option_month = ""
    option_side = ""

    for idx, row in df.iterrows():
        values = [clean_text(v) for v in row.tolist()]
        nonempty = [v for v in values if v]
        if not nonempty:
            continue

        first = nonempty[0]
        if first == "Futures":
            mode = "futures_wait_header"
            sections.append({"row": idx, "section": "Futures"})
            continue

        if first.startswith("OPTION TYPE:"):
            mode = "option_section"
            option_type = first.replace("OPTION TYPE:", "").strip()
            option_month = ""
            option_side = ""
            sections.append({"row": idx, "section": option_type})
            continue

        if mode == "futures_wait_header" and first == "Month":
            mode = "futures"
            continue

        if mode == "futures":
            if first == "TOTALS":
                futures.append(make_future_row(path, "TOTALS", values, idx, is_total=True))
                mode = ""
                continue
            if re.match(r"^[A-Z]{3}\s+\d{2}$", first):
                futures.append(make_future_row(path, first, values, idx, is_total=False))
                continue

        if mode in {"option_section", "option"}:
            if first == "No month data for this option type":
                mode = ""
                continue
            if re.match(r"^[A-Z]{3}\s+\d{2}\s+(Calls|Puts)$", first):
                option_month, option_side = first.rsplit(" ", 1)
                mode = "option_wait_header"
                continue
            if mode == "option_wait_header" and first == "Strike":
                mode = "option"
                continue
            if mode == "option":
                if first == "TOTALS":
                    options.append(make_option_row(path, option_type, option_month, option_side, values, idx, is_total=True))
                    mode = "option_section"
                    continue
                if first.replace(".", "", 1).isdigit():
                    options.append(make_option_row(path, option_type, option_month, option_side, values, idx, is_total=False))
                    continue

    return futures, options, sections


def make_future_row(path: Path, month: str, values: list[str], row_index: int, is_total: bool) -> dict[str, Any]:
    padded = values + [""] * 12
    row = {
        "source_file": str(path),
        "row_index": row_index,
        "is_total": is_total,
        "sensor_family": "cme_voi_futures_open_interest",
    }
    for key, val in zip(FUTURE_COLUMNS, padded[:12]):
        row[key] = month if key == "month" else clean_num(val)
    return row


def make_option_row(
    path: Path,
    option_type: str,
    month: str,
    side: str,
    values: list[str],
    row_index: int,
    is_total: bool,
) -> dict[str, Any]:
    padded = values + [""] * 10
    row = {
        "source_file": str(path),
        "row_index": row_index,
        "is_total": is_total,
        "sensor_family": "cme_voi_options_open_interest",
        "option_type": option_type,
        "option_month": month,
        "option_side": side,
    }
    for key, val in zip(OPTION_COLUMNS, padded[:10]):
        row[key] = "TOTALS" if key == "strike" and is_total else clean_num(val)
    return row


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = DEFAULT_INPUT
    if not path.exists():
        raise FileNotFoundError(path)

    futures, options, sections = parse_voi(path)
    future_totals = [row for row in futures if row["is_total"]]
    option_totals = [row for row in options if row["is_total"]]
    future_months = [row for row in futures if not row["is_total"]]

    total_future_volume = sum(row["total_volume"] for row in future_totals)
    total_future_oi = sum(row["open_interest_at_close"] for row in future_totals)
    total_option_volume = sum(row["total_volume"] for row in option_totals)
    total_option_oi = sum(row["open_interest_at_close"] for row in option_totals)
    top_months = sorted(future_months, key=lambda row: row["open_interest_at_close"], reverse=True)[:8]

    summary = {
        "version": VERSION,
        "input_file": str(path),
        "source_url": SOURCE_URL,
        "product_identity": "confirmed_cme_group_gold_futures_volume_open_interest",
        "product_family": "CME Gold Futures",
        "cme_product_page": "Gold Volume & OI",
        "futures_rows": len(futures),
        "futures_contract_months": len(future_months),
        "option_rows": len(options),
        "option_total_sections": len(option_totals),
        "total_future_volume": total_future_volume,
        "total_future_open_interest_at_close": total_future_oi,
        "total_option_volume": total_option_volume,
        "total_option_open_interest_at_close": total_option_oi,
        "top_future_months_by_open_interest": [
            {
                "month": row["month"],
                "total_volume": row["total_volume"],
                "open_interest_at_close": row["open_interest_at_close"],
                "open_interest_change": row["open_interest_change"],
            }
            for row in top_months
        ],
        "usefulness": [
            "Can fill daily CME VOI snapshot for futures open interest and volume.",
            "Can build term-structure crowding and front-month concentration features.",
            "Can build options open-interest distribution and strike crowding features.",
            "It is a single-day snapshot unless archived daily; it is not a historical replay by itself.",
        ],
    }

    write_csv(OUT_DIR / "hfcd_trading_v1_14_cme_voi_futures.csv", futures)
    write_csv(OUT_DIR / "hfcd_trading_v1_14_cme_voi_options.csv", options)
    write_csv(OUT_DIR / "hfcd_trading_v1_14_cme_voi_sections.csv", sections)
    (OUT_DIR / "hfcd_trading_v1_14_cme_voi_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    md = f"""# {VERSION}

## 文件判断

输入文件：`{path}`

来源页面：`{SOURCE_URL}`

这是从 CME Group Gold 产品页面下载的 VOI Details 表，包含 futures 与 options 的 Volume / Open Interest 明细。来源已由浏览器截图确认，因此可作为黄金期货 VOI 传感器。

## 解析结果

- Futures 合约月份行数：{len(future_months)}
- Futures 总成交量：{total_future_volume:,}
- Futures 总未平仓量 At Close：{total_future_oi:,}
- Options 明细行数：{len(options)}
- Options 总成交量：{total_option_volume:,}
- Options 总未平仓量 At Close：{total_option_oi:,}

## Futures OI 前几个月份

| 月份 | 成交量 | At Close OI | OI 变化 |
|---|---:|---:|---:|
{chr(10).join(f"| {row['month']} | {row['total_volume']:,} | {row['open_interest_at_close']:,} | {row['open_interest_change']:,} |" for row in top_months)}

## 交易模型用途

这个文件可作为黄金/贵金属线的真实 CME 传感器：

- `C腔`：成交量、Globex/Block/EFP/TAS 结构。
- `R半径`：未平仓量 At Close 与 Change，衡量拥挤度和仓位扩张。
- `τ时间项`：各到期月份 OI 分布，可辅助期限结构/换月风险。
- `Bσ黑子`：期权行权价 OI 分布，可观察极端行权价拥挤和潜在脆弱点。

限制：

- 它是单日快照，不是历史序列。要真正训练，需要每天保存一份，或用 Databento/CME 拉历史。
- 文件本身没有产品名字段；本次通过下载来源页面确认其为 CME Gold。后续归档时必须同时保存来源 URL 或下载日志。
"""
    (OUT_DIR / "HFCD_Trading_V1_14_CME_VOI_LocalParser.md").write_text(md, encoding="utf-8")

    print(json.dumps({k: summary[k] for k in [
        "version",
        "futures_contract_months",
        "total_future_volume",
        "total_future_open_interest_at_close",
        "total_option_volume",
        "total_option_open_interest_at_close",
    ]}, ensure_ascii=False, indent=2))
    print(f"out_dir={OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
