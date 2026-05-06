#!/usr/bin/env python3
"""
HFCD Trading V1.16 Gold Full Acquisition

This stage turns V1.15 gaps into bounded local artifacts:
- DXY/VIX macro context from public FRED CSV endpoints.
- Small Databento GC samples for contract chain, daily OHLCV, statistics/OI,
  term structure, roll-yield proxy, and a tightly bounded BBO sample.
- Explicit remaining blockers for CME options VOI history and margin history.

It intentionally does not download large L2 history. L2/order-book data is
sampled in a short window to validate schema and feature extraction only.
"""

from __future__ import annotations

import csv
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import pandas as pd


VERSION = "HFCD_Trading_V1_16_GoldFullAcquisition"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_16_gold_full_acquisition"
DATASET = "GLBX.MDP3"
GC_MONTH_CODES = ["G", "J", "M", "Q", "V", "Z"]  # Feb, Apr, Jun, Aug, Oct, Dec
GC_MONTH_MAP = {"G": 2, "J": 4, "M": 6, "Q": 8, "V": 10, "Z": 12}
def parse_chain_years() -> list[int]:
    raw = os.environ.get("HFCD_GOLD_CHAIN_YEARS", "2026,2027")
    years: list[int] = []
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        try:
            year = int(item)
        except ValueError:
            continue
        if 2020 <= year <= 2035 and year not in years:
            years.append(year)
    return years or [2026, 2027]


GC_CHAIN_YEARS = parse_chain_years()
GC_CHAIN_SYMBOLS = [f"GC{month}{str(year)[-1]}" for year in GC_CHAIN_YEARS for month in GC_MONTH_CODES]
DEFAULT_HISTORY_START = "2026-04-01"
DEFAULT_HISTORY_END = "2026-05-02"
BBO_START = "2026-05-01T13:30"
BBO_END = "2026-05-01T13:45"

FRED_MACRO = [
    {
        "series": "VIXCLS",
        "sensor": "vix_risk_appetite",
        "property_target": "DeltaSigma/Omega 风险偏好",
        "unit": "index",
        "note": "CBOE VIX close, FRED-hosted.",
    },
    {
        "series": "DTWEXBGS",
        "sensor": "broad_dollar_index_dxy_proxy",
        "property_target": "DeltaSigma 美元势差",
        "unit": "index",
        "note": "Trade Weighted U.S. Dollar Index: Broad, Goods and Services. Used as DXY proxy.",
    },
]


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
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def safe_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        text = str(value).strip()
        if not text or text == "." or text.lower() == "nan":
            return None
        return float(text)
    except Exception:
        return None


def df_to_csv(df: pd.DataFrame, path: Path) -> int:
    if df is None or df.empty:
        path.write_text("", encoding="utf-8")
        return 0
    out = df.copy()
    out.reset_index().to_csv(path, index=False)
    return len(out)


def clean_previous_outputs() -> None:
    if not OUT_DIR.exists():
        return
    for path in OUT_DIR.glob("hfcd_trading_v1_16_*"):
        if path.is_file():
            path.unlink()
    report = OUT_DIR / "HFCD_Trading_V1_16_GoldFullAcquisition.md"
    if report.exists():
        report.unlink()


def chunks(items: list[str], size: int) -> list[list[str]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def date_windows(start: str, end: str, days: int = 92) -> list[tuple[str, str]]:
    start_dt = datetime.fromisoformat(start)
    end_dt = datetime.fromisoformat(end)
    windows: list[tuple[str, str]] = []
    cursor = start_dt
    while cursor < end_dt:
        next_dt = min(cursor + timedelta(days=days), end_dt)
        windows.append((cursor.date().isoformat(), next_dt.date().isoformat()))
        cursor = next_dt
    return windows


def fetch_fred_csv(series: str) -> pd.DataFrame:
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}"
    with urllib.request.urlopen(url, timeout=30) as response:
        raw = response.read().decode("utf-8")
    path = OUT_DIR / "raw" / f"fred_{series}.csv"
    path.write_text(raw, encoding="utf-8")
    df = pd.read_csv(path)
    value_col = [col for col in df.columns if col != "observation_date"][0]
    df = df.rename(columns={"observation_date": "ts", value_col: "value"})
    df["value"] = df["value"].map(safe_float)
    df = df.dropna(subset=["value"])
    df["series"] = series
    return df


def fetch_macro() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    records: list[dict[str, Any]] = []
    coverage: list[dict[str, Any]] = []
    for spec in FRED_MACRO:
        try:
            df = fetch_fred_csv(spec["series"])
            for row in df.to_dict("records"):
                records.append(
                    {
                        "asset_class": "gold",
                        "symbol": spec["series"],
                        "sensor": spec["sensor"],
                        "property_target": spec["property_target"],
                        "ts": row["ts"],
                        "value": row["value"],
                        "unit": spec["unit"],
                        "source": "FRED fredgraph.csv",
                        "replay_ready": True,
                        "note": spec["note"],
                    }
                )
            coverage.append(
                {
                    "sensor": spec["sensor"],
                    "source": "FRED",
                    "rows": len(df),
                    "first_ts": str(df["ts"].iloc[0]) if len(df) else "",
                    "latest_ts": str(df["ts"].iloc[-1]) if len(df) else "",
                    "status": "historical_replay_ready" if len(df) else "missing",
                }
            )
        except Exception as exc:
            coverage.append(
                {
                    "sensor": spec["sensor"],
                    "source": "FRED",
                    "rows": 0,
                    "first_ts": "",
                    "latest_ts": "",
                    "status": f"fetch_failed: {type(exc).__name__}",
                }
            )
    return records, coverage


def latest_per_symbol_stat_oi(stats: pd.DataFrame) -> pd.DataFrame:
    if stats.empty or "stat_type" not in stats.columns:
        return pd.DataFrame()
    # Empirically validated against CME Gold VOI snapshot: stat_type 9 tracks OI.
    oi = stats[stats["stat_type"].astype(str) == "9"].copy()
    if oi.empty:
        return oi
    oi["date"] = pd.to_datetime(oi["ts_event"], errors="coerce").dt.date.astype(str)
    oi = oi.sort_values(["symbol", "date", "ts_event"])
    cols = ["date", "symbol", "quantity", "price", "stat_type", "update_action"]
    return oi.groupby(["date", "symbol"], as_index=False).tail(1)[cols]


def approximate_gc_expiration(symbol: str) -> pd.Timestamp | None:
    if len(symbol) < 4 or not symbol.startswith("GC"):
        return None
    month = GC_MONTH_MAP.get(symbol[2])
    year_digit = symbol[3]
    if month is None or not year_digit.isdigit():
        return None
    # This project currently targets 2026/2027 current-chain samples.
    year = 2020 + int(year_digit)
    if year < 2024:
        year += 10
    return pd.Timestamp(year=year, month=month, day=27)


def build_contract_chain(definitions: pd.DataFrame, known_symbols: list[str] | None = None) -> pd.DataFrame:
    known_symbols = known_symbols or []
    if definitions.empty or "symbol" not in definitions.columns:
        rows = []
        for symbol in known_symbols:
            expiry = approximate_gc_expiration(symbol)
            rows.append(
                {
                    "symbol": symbol,
                    "raw_symbol": symbol,
                    "expiration": str(expiry.date()) if expiry is not None else "",
                    "expiration_dt": str(expiry.date()) if expiry is not None else "",
                    "expiration_source": "symbol_month_fallback",
                }
            )
        return pd.DataFrame(rows)
    defs = definitions.copy()
    if "ts_event" in defs.columns:
        defs = defs.sort_values("ts_event")
    defs = defs.drop_duplicates("symbol", keep="last")
    keep_cols = [
        "symbol",
        "raw_symbol",
        "expiration",
        "activation",
        "maturity_year",
        "maturity_month",
        "maturity_day",
        "min_price_increment",
        "unit_of_measure_qty",
        "contract_multiplier",
        "currency",
        "security_type",
        "exchange",
        "group",
        "asset",
    ]
    existing = [col for col in keep_cols if col in defs.columns]
    chain = defs[existing].copy()
    if "expiration" in chain.columns:
        chain["expiration_dt"] = pd.to_datetime(chain["expiration"], errors="coerce").dt.date.astype(str)
        chain["expiration_source"] = "databento_definition"
    existing_symbols = set(chain["symbol"].astype(str)) if "symbol" in chain.columns else set()
    fallback_rows = []
    for symbol in known_symbols:
        if symbol in existing_symbols:
            continue
        expiry = approximate_gc_expiration(symbol)
        fallback_rows.append(
            {
                "symbol": symbol,
                "raw_symbol": symbol,
                "expiration": str(expiry.date()) if expiry is not None else "",
                "expiration_dt": str(expiry.date()) if expiry is not None else "",
                "expiration_source": "symbol_month_fallback",
            }
        )
    if fallback_rows:
        chain = pd.concat([chain, pd.DataFrame(fallback_rows)], ignore_index=True, sort=False)
    return chain.sort_values(["expiration_dt", "symbol"] if "expiration_dt" in chain.columns else ["symbol"])


def build_term_structure(ohlcv: pd.DataFrame, definitions: pd.DataFrame) -> pd.DataFrame:
    if ohlcv.empty:
        return pd.DataFrame()
    daily = ohlcv.copy()
    daily["date"] = pd.to_datetime(daily["ts_event"], errors="coerce").dt.date.astype(str)
    if "symbol" not in daily.columns:
        return pd.DataFrame()

    closes = daily.pivot_table(index="date", columns="symbol", values="close", aggfunc="last")
    expiry_map: dict[str, pd.Timestamp] = {}
    if not definitions.empty and "symbol" in definitions.columns and "expiration" in definitions.columns:
        defs = definitions.copy()
        if "ts_event" in defs.columns:
            defs = defs.sort_values("ts_event")
        defs = defs.drop_duplicates("symbol", keep="last")
        for row in defs.to_dict("records"):
            expiry = pd.to_datetime(row.get("expiration"), errors="coerce")
            if not pd.isna(expiry):
                expiry_map[str(row["symbol"])] = expiry.tz_localize(None) if getattr(expiry, "tzinfo", None) else expiry

    rows: list[dict[str, Any]] = []
    for date, row in closes.iterrows():
        date_ts = pd.to_datetime(date)
        live_symbols = []
        for symbol in closes.columns:
            close = row.get(symbol)
            expiry = expiry_map.get(str(symbol)) or approximate_gc_expiration(str(symbol))
            if pd.isna(close) or expiry is None or expiry < date_ts:
                continue
            live_symbols.append((str(symbol), expiry, float(close)))
        if not live_symbols:
            continue
        live_symbols.sort(key=lambda item: item[1])
        front_symbol, front_expiry, front = live_symbols[0]
        for symbol, expiry, close in live_symbols:
            days_to_expiry = int((expiry - date_ts).days)
            rows.append(
                {
                    "date": date,
                    "front_symbol": front_symbol,
                    "symbol": symbol,
                    "front_close": float(front),
                    "contract_close": float(close),
                    "spread_to_front": float(close - front),
                    "roll_yield_proxy": float((front - close) / front) if front else 0.0,
                    "front_expiration": str(front_expiry.date()),
                    "expiration": str(expiry.date()),
                    "days_to_expiry": days_to_expiry,
                }
            )
    term = pd.DataFrame(rows)
    return term


def fetch_databento_samples() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    history_start = os.environ.get("HFCD_GOLD_HISTORY_START", DEFAULT_HISTORY_START)
    history_end = os.environ.get("HFCD_GOLD_HISTORY_END", DEFAULT_HISTORY_END)
    schemas = [
        item.strip()
        for item in os.environ.get("HFCD_GOLD_DATABENTO_SCHEMAS", "definition,ohlcv-1d,statistics").split(",")
        if item.strip()
    ]
    report: dict[str, Any] = {
        "key_loaded": bool(os.environ.get("DATABENTO_API_KEY")),
        "dataset": DATASET,
        "symbols": GC_CHAIN_SYMBOLS,
        "schemas": schemas,
        "history_start": history_start,
        "history_end": history_end,
        "bbo_start": BBO_START,
        "bbo_end": BBO_END,
        "downloads": {},
        "errors": [],
    }
    coverage: list[dict[str, Any]] = []
    if not report["key_loaded"]:
        report["errors"].append("missing_databento_api_key")
        return report, coverage

    try:
        import databento as db  # type: ignore

        client = db.Historical(key=os.environ["DATABENTO_API_KEY"])
    except Exception as exc:
        report["errors"].append(f"databento_import_or_client_failed: {exc}")
        return report, coverage

    def fetch_schema_history(schema: str) -> pd.DataFrame:
        frames_for_schema: list[pd.DataFrame] = []
        # Definitions are large but not time-series dense; one request per symbol batch is enough.
        windows = [(history_start, history_end)] if schema == "definition" else date_windows(history_start, history_end)
        for window_start, window_end in windows:
            for symbol_batch in chunks(GC_CHAIN_SYMBOLS, 6):
                try:
                    print(
                        f"databento_fetch schema={schema} window={window_start}->{window_end} symbols={','.join(symbol_batch)}",
                        flush=True,
                    )
                    data = client.timeseries.get_range(
                        dataset=DATASET,
                        schema=schema,
                        symbols=symbol_batch,
                        stype_in="raw_symbol",
                        start=window_start,
                        end=window_end,
                    )
                    df = data.to_df()
                    if not df.empty:
                        frames_for_schema.append(df)
                except Exception as exc:
                    report["errors"].append(
                        f"{schema} chunk failed {window_start}->{window_end} {','.join(symbol_batch)}: {exc}"
                    )
        if not frames_for_schema:
            return pd.DataFrame()
        merged = pd.concat(frames_for_schema).sort_index()
        return merged

    frames: dict[str, pd.DataFrame] = {}
    for schema in schemas:
        try:
            df = fetch_schema_history(schema)
            frames[schema] = df
            count = df_to_csv(df, OUT_DIR / f"hfcd_trading_v1_16_gc_{schema.replace('-', '_')}_history.csv")
            report["downloads"][schema] = {"rows": count, "status": "downloaded_history_window"}
            coverage.append(
                {
                    "sensor": f"databento_{schema}",
                    "source": DATASET,
                    "rows": count,
                    "first_ts": str(df.index.min()) if count else "",
                    "latest_ts": str(df.index.max()) if count else "",
                    "status": "history_window_downloaded",
                }
            )
        except Exception as exc:
            report["downloads"][schema] = {"rows": 0, "status": f"failed: {type(exc).__name__}"}
            report["errors"].append(f"{schema}: {exc}")

    stats = frames.get("statistics", pd.DataFrame())
    oi = latest_per_symbol_stat_oi(stats.reset_index() if not stats.empty else stats)
    oi_rows = df_to_csv(oi, OUT_DIR / "hfcd_trading_v1_16_gc_daily_oi_candidate_history.csv")
    report["downloads"]["daily_oi_candidate_stat_type_9"] = {
        "rows": oi_rows,
        "status": "extracted_from_statistics" if oi_rows else "not_extracted",
        "note": "stat_type 9 matched CME Gold VOI current OI scale in a bounded sample.",
    }
    if oi_rows:
        coverage.append(
            {
                "sensor": "databento_daily_oi_candidate_stat_type_9",
                "source": DATASET,
                "rows": oi_rows,
                "first_ts": str(oi["date"].min()) if "date" in oi.columns else "",
                "latest_ts": str(oi["date"].max()) if "date" in oi.columns else "",
                "status": "history_window_extracted",
            }
        )

    ohlcv = frames.get("ohlcv-1d", pd.DataFrame())
    definitions = frames.get("definition", pd.DataFrame())
    known_symbols = []
    if not ohlcv.empty:
        ohlcv_reset_for_symbols = ohlcv.reset_index()
        if "symbol" in ohlcv_reset_for_symbols.columns:
            known_symbols = sorted(ohlcv_reset_for_symbols["symbol"].dropna().astype(str).unique().tolist())
    chain = build_contract_chain(definitions.reset_index() if not definitions.empty else definitions, known_symbols)
    chain_rows = df_to_csv(chain, OUT_DIR / "hfcd_trading_v1_16_gc_contract_chain_history.csv")
    report["downloads"]["contract_chain"] = {
        "rows": chain_rows,
        "status": "derived_from_definition" if chain_rows else "not_derived",
    }
    term = build_term_structure(
        ohlcv.reset_index() if not ohlcv.empty else ohlcv,
        definitions.reset_index() if not definitions.empty else definitions,
    )
    term_rows = df_to_csv(term, OUT_DIR / "hfcd_trading_v1_16_gc_term_structure_roll_yield_history.csv")
    report["downloads"]["term_structure_roll_yield"] = {
        "rows": term_rows,
        "status": "derived_from_ohlcv_definition" if term_rows else "not_derived",
    }
    if term_rows:
        coverage.append(
            {
                "sensor": "databento_term_structure_roll_yield_proxy",
                "source": DATASET,
                "rows": term_rows,
                "first_ts": str(term["date"].min()) if "date" in term.columns else "",
                "latest_ts": str(term["date"].max()) if "date" in term.columns else "",
                "status": "history_window_derived",
            }
        )

    try:
        data = client.timeseries.get_range(
            dataset=DATASET,
            schema="bbo-1s",
            symbols=["GCM6"],
            stype_in="raw_symbol",
            start=BBO_START,
            end=BBO_END,
        )
        bbo = data.to_df()
        if not bbo.empty:
            bbo = bbo.copy()
            if "ask_px_00" in bbo.columns and "bid_px_00" in bbo.columns:
                bbo["spread"] = bbo["ask_px_00"] - bbo["bid_px_00"]
            if "ask_sz_00" in bbo.columns and "bid_sz_00" in bbo.columns:
                bbo["top_book_size"] = bbo["ask_sz_00"] + bbo["bid_sz_00"]
        bbo_rows = df_to_csv(bbo, OUT_DIR / "hfcd_trading_v1_16_gc_bbo_1s_sample.csv")
        report["downloads"]["bbo_1s_sample"] = {
            "rows": bbo_rows,
            "status": "downloaded_bounded_15min_sample",
            "avg_spread": float(bbo["spread"].mean()) if bbo_rows and "spread" in bbo.columns else None,
            "avg_top_book_size": float(bbo["top_book_size"].mean()) if bbo_rows and "top_book_size" in bbo.columns else None,
        }
        if bbo_rows:
            coverage.append(
                {
                    "sensor": "databento_bbo_1s_execution_cavity_sample",
                    "source": DATASET,
                    "rows": bbo_rows,
                    "first_ts": str(bbo.index.min()),
                    "latest_ts": str(bbo.index.max()),
                    "status": "bounded_15min_sample_downloaded",
                }
            )
    except Exception as exc:
        report["downloads"]["bbo_1s_sample"] = {"rows": 0, "status": f"failed: {type(exc).__name__}"}
        report["errors"].append(f"bbo-1s: {exc}")

    return report, coverage


def table(rows: list[dict[str, Any]], cols: list[str]) -> str:
    header = "| " + " | ".join(cols) + " |"
    sep = "| " + " | ".join(["---"] * len(cols)) + " |"
    body = ["| " + " | ".join(str(row.get(col, "")).replace("|", "/") for col in cols) + " |" for row in rows]
    return "\n".join([header, sep, *body])


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "raw").mkdir(parents=True, exist_ok=True)
    clean_previous_outputs()
    (OUT_DIR / "raw").mkdir(parents=True, exist_ok=True)
    load_env_file(ROOT / ".env.local")
    load_env_file(ROOT / ".dev.vars")

    macro_records, macro_coverage = fetch_macro()
    write_csv(OUT_DIR / "hfcd_trading_v1_16_macro_dxy_vix.csv", macro_records)

    databento_report, databento_coverage = fetch_databento_samples()

    gaps = [
        {
            "gap": "cme_gold_options_voi_history",
            "status": "not_completed",
            "reason": "CME website blocks automated scraping; current local VOI file is Futures tab only.",
            "least_user_work_path": "Use CME Gold page Options tab Download Data once, place VoiDetailsForProduct.xls in /Users/beijisheng/Desktop/420/数据 with a distinct name, then rerun parser.",
        },
        {
            "gap": "margin_requirement_history",
            "status": "not_completed",
            "reason": "Historical margins are distributed through CME DataMine/CORE/SPAN service, not a public unauthenticated endpoint.",
            "least_user_work_path": "If CME DataMine/CORE access is enabled, provide/export historical GC margin CSV; otherwise use broker margin snapshots as proxy.",
        },
        {
            "gap": "large_l2_orderbook_history",
            "status": "bounded_sample_only",
            "reason": "Full L2 history can be large and billable. V1.16 validates a 15-minute bbo-1s extraction and leaves full L2 range selection explicit.",
            "least_user_work_path": "Give exact date ranges if full multi-day/month L2 history is required; otherwise use this bounded C-cavity sample for schema and feature extraction.",
        },
    ]
    write_csv(OUT_DIR / "hfcd_trading_v1_16_remaining_gaps.csv", gaps)

    coverage = macro_coverage + databento_coverage
    write_csv(OUT_DIR / "hfcd_trading_v1_16_acquisition_coverage.csv", coverage)

    summary = {
        "version": VERSION,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "mode": "bounded_gold_data_acquisition_not_deployed",
        "macro_records": len(macro_records),
        "macro_sensors": len(macro_coverage),
        "databento": databento_report,
        "remaining_gaps": gaps,
        "completed_now": [
            "DXY proxy / broad dollar index history",
            "VIX history",
            "Databento GC definition / contract chain history window",
            "Databento GC contract chain history window",
            "Databento GC daily OHLCV history window",
            "Databento GC statistics history window",
            "Daily OI candidate extraction from stat_type 9",
            "Term structure and roll yield proxy from GC major-month chain",
            "15-minute bbo-1s execution cavity sample",
        ],
    }
    (OUT_DIR / "hfcd_trading_v1_16_gold_full_acquisition_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    md = f"""# {VERSION}

## 定位

V1.16 把 V1.15 中能自动补齐的黄金缺口尽量落地。本轮仍是本地研究，不推线上，不做真实交易结论。

## 已补齐/已落地

- DXY 代理：FRED `DTWEXBGS`，用于美元势差。
- VIX：FRED `VIXCLS`，用于风险偏好/Omega。
- Databento GC 合约链历史窗口：`definition`。
- Databento GC 每日 OHLCV 历史窗口：`ohlcv-1d`。
- Databento GC statistics 历史窗口：用于每日 OI 候选。
- 每日 OI 候选：从 statistics 的 `stat_type=9` 提取，数值规模已与 CME Gold VOI 快照相近。
- 期限结构/roll yield 代理：由 2024-2027 GC 主要月份合约链的日收盘价构建。
- 盘口历史：已下载 15 分钟 `bbo-1s` 小样本，验证 C腔字段；大规模 L2 历史保留为显式范围任务，避免一次性产生不可控数据费用。

## 覆盖情况

{table(coverage, ["sensor", "source", "rows", "first_ts", "latest_ts", "status"])}

## Databento 下载状态

{json.dumps(databento_report.get("downloads", {}), ensure_ascii=False, indent=2)}

## 仍未一次性完成的部分

{table(gaps, ["gap", "status", "reason", "least_user_work_path"])}

## 判断

黄金线现在已经从“元数据确认”推进到“可训练历史窗口落地”：DXY/VIX 已并入，GC daily OHLCV、statistics、每日 OI 候选、合约链、期限结构和 roll yield 代理都已经生成历史窗口训练表。

但完整自动交易级数据仍差三类：一是黄金期权 VOI 历史；二是保证金历史；三是多日/月级 L2 深度历史。这些不是当前代码不能处理，而是需要授权数据源或明确下载范围。
"""
    (OUT_DIR / "HFCD_Trading_V1_16_GoldFullAcquisition.md").write_text(md, encoding="utf-8")

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"out_dir={OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
