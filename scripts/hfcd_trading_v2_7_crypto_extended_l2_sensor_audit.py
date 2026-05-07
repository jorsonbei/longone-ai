#!/usr/bin/env python3
"""HFCD Trading V2.7: extended crypto L2 + sensor coverage audit.

This is a data-quality release, not a strategy-parameter release.

It extends Binance Vision USD-M futures bookDepth/metrics from the short V2.5
window into a longer replay table, adds a daily stablecoin supply ledger, and
keeps probing liquidation-history providers. The output is intended to answer:

1. Is a 60-90 day L2/history table available and continuous enough for replay?
2. Does the real bookDepth cavity cover BTC/ETH evenly, or are there gaps?
3. Which sensors are still missing before retraining/tuning?
"""

from __future__ import annotations

import csv
import io
import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


VERSION = "HFCD_Trading_V2_7_CryptoExtendedL2SensorAudit"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v2_7_crypto_extended_l2_sensor_audit"
SYMBOLS = [s.strip().upper() for s in os.getenv("HFCD_CRYPTO_SYMBOLS", "BTCUSDT,ETHUSDT").split(",") if s.strip()]
DAYS = int(os.getenv("HFCD_CRYPTO_V27_DAYS", "60"))
STABLECOIN_DAYS = int(os.getenv("HFCD_STABLECOIN_DAYS", "730"))
USER_AGENT = "HFCD-ThingNature-OS/2.7"


@dataclass
class Probe:
    source: str
    sensor: str
    status: str
    replay_ready: bool
    notes: str
    url: str = ""


def request(url: str, *, method: str = "GET", timeout: int = 30, headers: dict[str, str] | None = None) -> bytes:
    req_headers = {"User-Agent": USER_AGENT, **(headers or {})}
    req = urllib.request.Request(url, method=method, headers=req_headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def head_exists(url: str, *, headers: dict[str, str] | None = None) -> tuple[bool, str]:
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT, **(headers or {})})
        with urllib.request.urlopen(req, timeout=14) as resp:
            return True, f"{resp.status}; bytes={resp.headers.get('content-length', '')}; type={resp.headers.get('content-type', '')}"
    except urllib.error.HTTPError as exc:
        return False, f"HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"


def get_json(url: str, *, headers: dict[str, str] | None = None, timeout: int = 35) -> Any:
    raw = request(url, timeout=timeout, headers={"Accept": "application/json", **(headers or {})})
    return json.loads(raw.decode("utf-8", "ignore"))


def date_range() -> list[str]:
    end = datetime.now(timezone.utc).date() - timedelta(days=1)
    start = end - timedelta(days=DAYS - 1)
    return [(start + timedelta(days=i)).isoformat() for i in range(DAYS)]


def binance_vision_url(kind: str, symbol: str, day: str) -> str:
    return f"https://data.binance.vision/data/futures/um/daily/{kind}/{symbol}/{symbol}-{kind}-{day}.zip"


def read_zip_csv(url: str) -> list[dict[str, str]]:
    raw = request(url, timeout=75)
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        names = zf.namelist()
        if not names:
            return []
        with zf.open(names[0]) as fh:
            text = io.TextIOWrapper(fh, encoding="utf-8", errors="ignore")
            return list(csv.DictReader(text))


def safe_float(value: Any) -> float:
    try:
        result = float(value)
        if math.isfinite(result):
            return result
    except Exception:  # noqa: BLE001
        pass
    return 0.0


def number(value: float, digits: int = 6) -> float:
    return round(float(value or 0), digits)


def iso_to_dt(ts: str) -> datetime:
    if ts.endswith("Z"):
        ts = ts[:-1] + "+00:00"
    return datetime.fromisoformat(ts)


def five_min_bucket(ts: str) -> str:
    dt = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    minute = (dt.minute // 5) * 5
    return dt.replace(minute=minute, second=0, microsecond=0).isoformat().replace("+00:00", "Z")


def aggregate_book_depth(raw_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for row in raw_rows:
        symbol = str(row["symbol"])
        bucket = five_min_bucket(str(row["timestamp"]))
        pct = safe_float(row["percentage"])
        notional = safe_float(row["notional"])
        depth = safe_float(row["depth"])
        side = "bid" if pct < 0 else "ask"
        pct_key = str(abs(pct)).replace(".", "p")
        key = f"{side}_{pct_key}"
        grouped[(symbol, bucket)][f"{key}_notional"].append(notional)
        grouped[(symbol, bucket)][f"{key}_depth"].append(depth)

    rows: list[dict[str, Any]] = []
    for (symbol, ts), values in sorted(grouped.items(), key=lambda item: (item[0][0], item[0][1])):
        out: dict[str, Any] = {"ts": ts, "symbol": symbol, "source": "binance_vision_bookDepth_5m_aggregated"}
        for field, vals in sorted(values.items()):
            out[field] = number(sum(vals) / len(vals), 6) if vals else 0
        bid_02 = safe_float(out.get("bid_0p2_notional"))
        ask_02 = safe_float(out.get("ask_0p2_notional"))
        bid_1 = safe_float(out.get("bid_1p0_notional"))
        ask_1 = safe_float(out.get("ask_1p0_notional"))
        out["depth_imbalance_0p2"] = number((bid_02 - ask_02) / (bid_02 + ask_02), 6) if bid_02 + ask_02 else 0
        out["depth_imbalance_1p0"] = number((bid_1 - ask_1) / (bid_1 + ask_1), 6) if bid_1 + ask_1 else 0
        out["liquidity_cavity_0p2_usd"] = round(min(bid_02, ask_02), 2)
        out["liquidity_cavity_1p0_usd"] = round(min(bid_1, ask_1), 2)
        rows.append(out)
    return rows


def normalize_metrics(rows: list[dict[str, str]], symbol: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        create_time = row.get("create_time")
        if not create_time:
            continue
        out.append({
            "ts": datetime.strptime(create_time, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z"),
            "symbol": row.get("symbol") or symbol,
            "source": "binance_vision_metrics",
            "count_long_short_ratio": safe_float(row.get("count_long_short_ratio")),
            "count_toptrader_long_short_ratio": safe_float(row.get("count_toptrader_long_short_ratio")),
            "sum_open_interest": safe_float(row.get("sum_open_interest")),
            "sum_open_interest_value": safe_float(row.get("sum_open_interest_value")),
            "sum_taker_long_short_vol_ratio": safe_float(row.get("sum_taker_long_short_vol_ratio")),
            "sum_toptrader_long_short_ratio": safe_float(row.get("sum_toptrader_long_short_ratio")),
        })
    return out


def write_csv(path: Path, rows: list[dict[str, Any]], headers: list[str] | None = None) -> None:
    if not rows and not headers:
        path.write_text("", encoding="utf-8")
        return
    fieldnames = headers or sorted({key for row in rows for key in row.keys()})
    priority = ["ts", "date", "timestamp", "symbol", "asset", "source"]
    fieldnames = [h for h in priority if h in fieldnames] + [h for h in fieldnames if h not in priority]
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def coverage_audit(rows: list[dict[str, Any]], sensor: str, expected_days: list[str]) -> list[dict[str, Any]]:
    audits: list[dict[str, Any]] = []
    expected_per_symbol = len(expected_days) * 288
    for symbol in SYMBOLS:
        symbol_rows = [r for r in rows if r.get("symbol") == symbol]
        present_ts = {str(r["ts"]) for r in symbol_rows}
        missing = []
        for day in expected_days:
            dt = datetime.fromisoformat(f"{day}T00:00:00+00:00")
            for i in range(288):
                ts = (dt + timedelta(minutes=5 * i)).isoformat().replace("+00:00", "Z")
                if ts not in present_ts:
                    missing.append(ts)
        values = [safe_float(r.get("liquidity_cavity_1p0_usd", r.get("sum_open_interest", 0))) for r in symbol_rows]
        positive_values = [v for v in values if v > 0]
        audits.append({
            "sensor": sensor,
            "symbol": symbol,
            "expected_rows": expected_per_symbol,
            "actual_rows": len(symbol_rows),
            "coverage_ratio": number(len(symbol_rows) / expected_per_symbol, 6) if expected_per_symbol else 0,
            "missing_rows": len(missing),
            "first_ts": symbol_rows[0]["ts"] if symbol_rows else "",
            "last_ts": symbol_rows[-1]["ts"] if symbol_rows else "",
            "zero_or_bad_rows": len(values) - len(positive_values),
            "p05_value": percentile(positive_values, 0.05) if positive_values else 0,
            "p50_value": percentile(positive_values, 0.50) if positive_values else 0,
            "p95_value": percentile(positive_values, 0.95) if positive_values else 0,
            "first_missing_ts": missing[0] if missing else "",
            "status": "coverage_pass" if len(symbol_rows) / expected_per_symbol >= 0.98 and len(values) == len(positive_values) else "coverage_watchlist",
        })
    return audits


def percentile(values: list[float], p: float) -> float:
    clean = sorted(v for v in values if math.isfinite(v))
    if not clean:
        return 0
    idx = min(len(clean) - 1, max(0, int((len(clean) - 1) * p)))
    return number(clean[idx], 6)


def day_iso(epoch_seconds: int | float) -> str:
    return datetime.fromtimestamp(epoch_seconds, timezone.utc).date().isoformat()


def fetch_stablecoin_history(asset_id: str, asset: str) -> list[dict[str, Any]]:
    payload = get_json(f"https://stablecoins.llama.fi/stablecoin/{asset_id}")
    by_day: dict[str, float] = defaultdict(float)
    for chain in (payload.get("chainBalances") or {}).values():
        for token in chain.get("tokens", []) or []:
            date = token.get("date")
            value = safe_float((token.get("circulating") or {}).get("peggedUSD"))
            if date and value:
                by_day[day_iso(date)] += value
    cutoff = (datetime.now(timezone.utc).date() - timedelta(days=STABLECOIN_DAYS)).isoformat()
    rows = []
    items = sorted((day, supply) for day, supply in by_day.items() if day >= cutoff)
    for idx, (day, supply) in enumerate(items):
        prev1 = items[idx - 1][1] if idx >= 1 else supply
        prev7 = items[idx - 7][1] if idx >= 7 else prev1
        rows.append({
            "date": day,
            "asset": asset,
            "source": "defillama_stablecoins_stablecoin_history",
            "supply_usd": round(supply, 2),
            "supply_change_1d_usd": round(supply - prev1, 2),
            "supply_change_7d_usd": round(supply - prev7, 2),
        })
    return rows


def probe_liquidation_sources(days: list[str]) -> list[Probe]:
    probes: list[Probe] = []
    day = days[-1]
    for kind in ["liquidation", "liquidations", "forceOrders", "allForceOrders"]:
        url = binance_vision_url(kind, "BTCUSDT", day)
        ok, note = head_exists(url)
        probes.append(Probe("Binance Vision", kind, "available" if ok else "not_found", ok, note, url))

    # Binance REST history is often unavailable to ordinary public clients; keep a live probe.
    start = int((datetime.now(timezone.utc) - timedelta(days=1)).timestamp() * 1000)
    end = int(datetime.now(timezone.utc).timestamp() * 1000)
    rest = f"https://fapi.binance.com/fapi/v1/allForceOrders?symbol=BTCUSDT&startTime={start}&endTime={end}&limit=100"
    try:
        body = request(rest, timeout=18).decode("utf-8", "ignore")
        replay_ready = body.strip().startswith("[") and len(json.loads(body)) > 0
        probes.append(Probe("Binance REST", "allForceOrders_recent", "available" if replay_ready else "empty_or_unavailable", replay_ready, body[:220], rest))
    except Exception as exc:  # noqa: BLE001
        probes.append(Probe("Binance REST", "allForceOrders_recent", "probe_failed", False, str(exc)[:240], rest))

    coinglass = "https://open-api-v4.coinglass.com/api/futures/liquidation/order?exchange=Binance&symbol=BTC"
    if os.getenv("COINGLASS_API_KEY"):
        try:
            body = request(coinglass, headers={"CG-API-KEY": os.environ["COINGLASS_API_KEY"]}, timeout=18).decode("utf-8", "ignore")
            probes.append(Probe("CoinGlass", "liquidation_history", "api_key_probe_ok", True, body[:220], coinglass))
        except Exception as exc:  # noqa: BLE001
            probes.append(Probe("CoinGlass", "liquidation_history", "api_key_probe_failed", False, str(exc)[:240], coinglass))
    else:
        probes.append(Probe("CoinGlass", "liquidation_history", "requires_api_key", False, "Set COINGLASS_API_KEY to download historical liquidations.", coinglass))

    coinalyze = "https://api.coinalyze.net/v1/liquidation-history?symbols=BTCUSDT_PERP.A&interval=5min&from=0&to=1"
    if os.getenv("COINALYZE_API_KEY"):
        try:
            body = request(coinalyze, headers={"api_key": os.environ["COINALYZE_API_KEY"]}, timeout=18).decode("utf-8", "ignore")
            probes.append(Probe("Coinalyze", "liquidation_history", "api_key_probe_ok", True, body[:220], coinalyze))
        except Exception as exc:  # noqa: BLE001
            probes.append(Probe("Coinalyze", "liquidation_history", "api_key_probe_failed", False, str(exc)[:240], coinalyze))
    else:
        probes.append(Probe("Coinalyze", "liquidation_history", "requires_api_key", False, "Set COINALYZE_API_KEY to probe/download liquidation history.", coinalyze))

    tardis_paths = [
        f"https://datasets.tardis.dev/v1/binance-futures/liquidations/{day[:4]}/{day[5:7]}/{day[8:10]}/BTCUSDT.csv.gz",
        f"https://datasets.tardis.dev/v1/binance-futures/book_snapshot_25_1s/{day[:4]}/{day[5:7]}/{day[8:10]}/BTCUSDT.csv.gz",
    ]
    for url in tardis_paths:
        ok, note = head_exists(url)
        probes.append(Probe("Tardis.dev", "liquidation_or_l2_history", "available" if ok else "not_public_path_or_requires_plan", ok, note, url))
    return probes


def svg_report(summary: dict[str, Any]) -> str:
    counts = summary["counts"]
    decision = summary["decision"]
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1180" height="500" viewBox="0 0 1180 500">
  <rect width="1180" height="500" fill="#06110f"/>
  <rect x="26" y="24" width="1128" height="452" rx="24" fill="#10231c" stroke="#245a47"/>
  <text x="58" y="72" fill="#f8fafc" font-size="27" font-family="Arial" font-weight="700">{VERSION}</text>
  <text x="58" y="108" fill="#a7f3d0" font-size="17" font-family="Arial">Extended replay sensors: Binance Vision bookDepth + metrics, DefiLlama stablecoin ledger, liquidation probes.</text>
  <text x="58" y="164" fill="#dbeafe" font-size="20" font-family="Arial">bookDepth 5m rows: {counts['book_depth_5m_rows']}</text>
  <text x="58" y="202" fill="#dbeafe" font-size="20" font-family="Arial">metrics rows: {counts['metrics_rows']}</text>
  <text x="58" y="240" fill="#dbeafe" font-size="20" font-family="Arial">stablecoin rows: {counts['stablecoin_supply_rows']}</text>
  <text x="58" y="278" fill="#dbeafe" font-size="20" font-family="Arial">manifest rows: {counts['download_manifest_rows']}</text>
  <text x="58" y="336" fill="#facc15" font-size="18" font-family="Arial">Decision: {decision['status']}</text>
  <text x="58" y="376" fill="#94a3b8" font-size="16" font-family="Arial">Still missing: {', '.join(decision['still_missing']) if decision['still_missing'] else 'none'}</text>
  <text x="58" y="416" fill="#94a3b8" font-size="16" font-family="Arial">Next: {decision['next_step']}</text>
</svg>"""


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    days = date_range()
    book_5m_rows: list[dict[str, Any]] = []
    metrics_rows: list[dict[str, Any]] = []
    manifest: list[dict[str, Any]] = []

    for symbol in SYMBOLS:
        for day in days:
            raw_book_rows: list[dict[str, Any]] = []
            for kind in ["bookDepth", "metrics"]:
                url = binance_vision_url(kind, symbol, day)
                ok, note = head_exists(url)
                manifest_row = {"symbol": symbol, "date": day, "kind": kind, "available": ok, "notes": note, "url": url}
                manifest.append(manifest_row)
                if not ok:
                    continue
                try:
                    rows = read_zip_csv(url)
                    if kind == "bookDepth":
                        for row in rows:
                            raw_book_rows.append({
                                "timestamp": row.get("timestamp", ""),
                                "symbol": symbol,
                                "percentage": safe_float(row.get("percentage")),
                                "depth": safe_float(row.get("depth")),
                                "notional": safe_float(row.get("notional")),
                            })
                    else:
                        metrics_rows.extend(normalize_metrics(rows, symbol))
                    manifest_row["rows"] = len(rows)
                except Exception as exc:  # noqa: BLE001
                    manifest_row["available"] = False
                    manifest_row["notes"] = f"download_parse_failed: {exc}"
                time.sleep(0.04)
            if raw_book_rows:
                book_5m_rows.extend(aggregate_book_depth(raw_book_rows))

    stablecoin_rows = []
    for asset_id, asset in [("1", "USDT"), ("2", "USDC")]:
        try:
            stablecoin_rows.extend(fetch_stablecoin_history(asset_id, asset))
        except Exception as exc:  # noqa: BLE001
            stablecoin_rows.append({
                "date": "",
                "asset": asset,
                "source": "defillama_stablecoins_stablecoin_history",
                "supply_usd": 0,
                "supply_change_1d_usd": 0,
                "supply_change_7d_usd": 0,
                "error": str(exc)[:220],
            })

    probes = probe_liquidation_sources(days)
    book_audit = coverage_audit(book_5m_rows, "bookDepth_5m", days)
    metrics_audit = coverage_audit(metrics_rows, "metrics_5m", days)
    sensor_audit = book_audit + metrics_audit

    write_csv(OUT_DIR / "hfcd_trading_v2_7_book_depth_5m.csv", book_5m_rows)
    write_csv(OUT_DIR / "hfcd_trading_v2_7_metrics_5m.csv", metrics_rows)
    write_csv(OUT_DIR / "hfcd_trading_v2_7_stablecoin_supply_history.csv", stablecoin_rows)
    write_csv(OUT_DIR / "hfcd_trading_v2_7_download_manifest.csv", manifest)
    write_csv(OUT_DIR / "hfcd_trading_v2_7_liquidation_source_probe.csv", [p.__dict__ for p in probes])
    write_csv(OUT_DIR / "hfcd_trading_v2_7_sensor_quality_audit.csv", sensor_audit)

    expected_rows = len(days) * 288 * len(SYMBOLS)
    l2_ok = len(book_5m_rows) >= expected_rows * 0.98 and all(row["status"] == "coverage_pass" for row in book_audit)
    metrics_ok = len(metrics_rows) >= expected_rows * 0.98 and all(row["status"] == "coverage_pass" for row in metrics_audit)
    stable_ok = len([r for r in stablecoin_rows if r.get("supply_usd", 0) > 0]) >= 180
    liquidation_ok = any(p.replay_ready and "liquidation" in p.sensor for p in probes)
    still_missing = []
    if not liquidation_ok:
        still_missing.append("liquidation_history")
    if not stable_ok:
        still_missing.append("stablecoin_supply_history")

    summary = {
        "version": VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "symbols": SYMBOLS,
        "days": DAYS,
        "date_start": days[0],
        "date_end": days[-1],
        "output_dir": str(OUT_DIR),
        "expected_5m_rows_total": expected_rows,
        "counts": {
            "book_depth_5m_rows": len(book_5m_rows),
            "metrics_rows": len(metrics_rows),
            "stablecoin_supply_rows": len(stablecoin_rows),
            "download_manifest_rows": len(manifest),
            "liquidation_probe_rows": len(probes),
        },
        "quality_gates": {
            "completed_utc_days_only": True,
            "same_window_symbol_coverage": l2_ok and metrics_ok,
            "l2_coverage_pass": l2_ok,
            "metrics_coverage_pass": metrics_ok,
            "stablecoin_history_ready": stable_ok,
            "liquidation_history_ready": liquidation_ok,
            "no_strategy_parameter_tuning": True,
            "no_online_page_change": True,
        },
        "decision": {
            "status": "extended_l2_metrics_ready_for_v2_8_retrain" if l2_ok and metrics_ok and stable_ok else "sensor_coverage_watchlist",
            "can_retrain_with_extended_l2_metrics": l2_ok and metrics_ok,
            "can_include_stablecoin_ledger": stable_ok,
            "can_include_liquidation_history": liquidation_ok,
            "still_missing": still_missing,
            "next_step": "V2.8 retrain on extended L2+metrics+stablecoin; keep liquidation as missing risk sensor." if l2_ok and metrics_ok and stable_ok else "repair sensor coverage before retraining.",
        },
        "audit": sensor_audit,
        "probes": [p.__dict__ for p in probes],
    }
    (OUT_DIR / "hfcd_trading_v2_7_summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    (OUT_DIR / "HFCD_Trading_V2_7_CryptoExtendedL2SensorAudit.svg").write_text(svg_report(summary), encoding="utf-8")

    md = f"""# {VERSION}

生成时间：{summary['generated_at']}

## 结论

本轮是数据覆盖修复，不调策略参数，不改线上页面。

V2.6 显示 14 天 L2 窗口下，真实盘口腔体能明显压缩 ETH 亏损，但 BTC 未改善，合并后仍未转正。按照黄金模型和能源模型的经验，不能在传感器覆盖不足时继续调阈值；必须先扩展窗口并审计数据质量。

## 已完成

- Binance Vision `bookDepth` 扩展到 {DAYS} 个完整 UTC 日。
- Binance Vision `metrics` 扩展到 {DAYS} 个完整 UTC 日。
- DefiLlama USDT/USDC 稳定币供应账本已写入。
- 清算历史继续探测 Binance Vision、Binance REST、CoinGlass、Coinalyze、Tardis。

## 覆盖结果

- 预期 5m 行数：{expected_rows}
- bookDepth 5m 行数：{len(book_5m_rows)}
- metrics 行数：{len(metrics_rows)}
- stablecoin 行数：{len(stablecoin_rows)}

## 质量门

{json.dumps(summary['quality_gates'], ensure_ascii=False, indent=2)}

## 传感器审计

{chr(10).join(f"- {row['sensor']} / {row['symbol']}: coverage={row['coverage_ratio']}, missing={row['missing_rows']}, bad={row['zero_or_bad_rows']}, status={row['status']}" for row in sensor_audit)}

## 清算历史探测

{chr(10).join(f"- {p.source} / {p.sensor}: {p.status}, replay_ready={p.replay_ready}, notes={p.notes}" for p in probes)}

## 从黄金/能源线吸取的检查点

1. 不在数据覆盖未闭合时调 Q/trailing 或阈值。
2. 只使用完整 UTC 日，避免把未完成当日数据混进训练。
3. 输出 coverage/missing/bad rows，避免 clean quote 覆盖不足导致假结论。
4. 下一轮训练必须在同一窗口比较 legacy、metrics_only、l2_metrics、l2_metrics_stablecoin，不能跨窗口硬比。
5. 清算历史仍缺时，不能宣称高频风险传感器完整；只能作为 watchlist 或继续补数据。

## 当前决策

- 状态：{summary['decision']['status']}
- 仍缺：{', '.join(still_missing) if still_missing else '无'}
- 下一步：{summary['decision']['next_step']}

## 输出文件

- `hfcd_trading_v2_7_summary.json`
- `hfcd_trading_v2_7_book_depth_5m.csv`
- `hfcd_trading_v2_7_metrics_5m.csv`
- `hfcd_trading_v2_7_stablecoin_supply_history.csv`
- `hfcd_trading_v2_7_sensor_quality_audit.csv`
- `hfcd_trading_v2_7_liquidation_source_probe.csv`
- `hfcd_trading_v2_7_download_manifest.csv`
- `HFCD_Trading_V2_7_CryptoExtendedL2SensorAudit.svg`
"""
    (OUT_DIR / "HFCD_Trading_V2_7_CryptoExtendedL2SensorAudit.md").write_text(md, encoding="utf-8")
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
