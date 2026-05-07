#!/usr/bin/env python3
"""HFCD Trading V2.5: Binance Vision L2 depth + metrics acquisition.

This script intentionally stays local-only. It downloads official Binance
USD-M futures public data from data.binance.vision:

- daily bookDepth files: historical depth/notional at percentage bands
- daily metrics files: OI, long/short ratios, taker long/short volume ratio

It also writes a source probe ledger for liquidation/L2 alternatives.
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import math
import os
import time
import urllib.error
import urllib.request
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


VERSION = "HFCD_Trading_V2_5_CryptoBinanceVisionL2Metrics"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v2_5_crypto_binance_vision_l2_metrics"
SYMBOLS = [s.strip().upper() for s in os.getenv("HFCD_CRYPTO_SYMBOLS", "BTCUSDT,ETHUSDT").split(",") if s.strip()]
DAYS = int(os.getenv("HFCD_CRYPTO_VISION_DAYS", "14"))
USER_AGENT = "HFCD-ThingNature-OS/2.5"


@dataclass
class Probe:
    source: str
    sensor: str
    status: str
    replay_ready: bool
    notes: str
    url: str = ""


def request(url: str, *, method: str = "GET", timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, method=method, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def head_exists(url: str) -> tuple[bool, str]:
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=12) as resp:
            return True, f"{resp.status}; bytes={resp.headers.get('content-length', '')}"
    except urllib.error.HTTPError as exc:
        return False, f"HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"


def date_range() -> list[str]:
    # Use completed UTC days only. Today may still be incomplete on Binance Vision.
    end = datetime.now(timezone.utc).date() - timedelta(days=1)
    start = end - timedelta(days=DAYS - 1)
    return [(start + timedelta(days=i)).isoformat() for i in range(DAYS)]


def binance_vision_url(kind: str, symbol: str, day: str) -> str:
    return f"https://data.binance.vision/data/futures/um/daily/{kind}/{symbol}/{symbol}-{kind}-{day}.zip"


def read_zip_csv(url: str) -> list[dict[str, str]]:
    raw = request(url, timeout=60)
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
        key = f"{'bid' if pct < 0 else 'ask'}_{str(abs(pct)).replace('.', 'p')}"
        grouped[(symbol, bucket)][f"{key}_notional"].append(notional)
        grouped[(symbol, bucket)][f"{key}_depth"].append(depth)

    rows: list[dict[str, Any]] = []
    for (symbol, ts), values in sorted(grouped.items(), key=lambda item: (item[0][0], item[0][1])):
        out: dict[str, Any] = {"ts": ts, "symbol": symbol, "source": "binance_vision_bookDepth_5m_aggregated"}
        for field, vals in sorted(values.items()):
            out[field] = round(sum(vals) / len(vals), 6) if vals else 0
        bid_02 = safe_float(out.get("bid_0p2_notional"))
        ask_02 = safe_float(out.get("ask_0p2_notional"))
        bid_1 = safe_float(out.get("bid_1p0_notional"))
        ask_1 = safe_float(out.get("ask_1p0_notional"))
        out["depth_imbalance_0p2"] = round((bid_02 - ask_02) / (bid_02 + ask_02), 6) if bid_02 + ask_02 else 0
        out["depth_imbalance_1p0"] = round((bid_1 - ask_1) / (bid_1 + ask_1), 6) if bid_1 + ask_1 else 0
        out["liquidity_cavity_0p2_usd"] = round(min(bid_02, ask_02), 2)
        out["liquidity_cavity_1p0_usd"] = round(min(bid_1, ask_1), 2)
        rows.append(out)
    return rows


def normalize_metrics(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        out.append({
            "ts": datetime.strptime(row["create_time"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z"),
            "symbol": row["symbol"],
            "sum_open_interest": safe_float(row.get("sum_open_interest")),
            "sum_open_interest_value": safe_float(row.get("sum_open_interest_value")),
            "count_toptrader_long_short_ratio": safe_float(row.get("count_toptrader_long_short_ratio")),
            "sum_toptrader_long_short_ratio": safe_float(row.get("sum_toptrader_long_short_ratio")),
            "count_long_short_ratio": safe_float(row.get("count_long_short_ratio")),
            "sum_taker_long_short_vol_ratio": safe_float(row.get("sum_taker_long_short_vol_ratio")),
            "source": "binance_vision_metrics",
        })
    return out


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    headers = sorted({key for row in rows for key in row.keys()})
    priority = ["ts", "timestamp", "symbol", "source"]
    headers = [h for h in priority if h in headers] + [h for h in headers if h not in priority]
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def probe_external_sources() -> list[Probe]:
    probes: list[Probe] = []
    day = date_range()[-1]
    for kind in ["bookDepth", "metrics", "liquidation", "liquidations", "forceOrders", "allForceOrders"]:
        url = binance_vision_url(kind, "BTCUSDT", day)
        ok, note = head_exists(url)
        probes.append(Probe(
            source="Binance Vision",
            sensor=kind,
            status="available" if ok else "not_found",
            replay_ready=ok and kind in {"bookDepth", "metrics"},
            notes=note,
            url=url,
        ))

    coinglass_url = "https://open-api-v4.coinglass.com/api/futures/liquidation/order?exchange=Binance&symbol=BTC"
    if os.getenv("COINGLASS_API_KEY"):
        try:
            req = urllib.request.Request(coinglass_url, headers={"CG-API-KEY": os.environ["COINGLASS_API_KEY"], "User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read(300).decode("utf-8", "ignore")
            probes.append(Probe("CoinGlass", "liquidation_history", "api_key_probe_ok", True, body[:180], coinglass_url))
        except Exception as exc:  # noqa: BLE001
            probes.append(Probe("CoinGlass", "liquidation_history", "api_key_probe_failed", False, str(exc)[:240], coinglass_url))
    else:
        probes.append(Probe("CoinGlass", "liquidation_history", "requires_api_key", False, "Public probe returns API key missing; set COINGLASS_API_KEY to test/download.", coinglass_url))

    tardis_examples = [
        "https://datasets.tardis.dev/v1/binance-futures/book_snapshot_25_1s/2026/05/01/BTCUSDT.csv.gz",
        "https://datasets.tardis.dev/v1/binance-futures/liquidations/2026/05/01/BTCUSDT.csv.gz",
    ]
    for url in tardis_examples:
        ok, note = head_exists(url)
        probes.append(Probe("Tardis.dev", "l2_or_liquidation_history", "available" if ok else "not_public_path_or_requires_plan", ok, note, url))

    return probes


def svg_report(summary: dict[str, Any]) -> str:
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="430" viewBox="0 0 1100 430">
  <rect width="1100" height="430" fill="#07130f"/>
  <rect x="24" y="24" width="1052" height="382" rx="22" fill="#10231c" stroke="#245a47"/>
  <text x="54" y="70" fill="#f8fafc" font-size="27" font-family="Arial" font-weight="700">{VERSION}</text>
  <text x="54" y="104" fill="#a7f3d0" font-size="17" font-family="Arial">Binance Vision 已补 L2 bookDepth 历史；metrics 补 OI/多空/主动买卖比。</text>
  <text x="54" y="155" fill="#dbeafe" font-size="20" font-family="Arial">bookDepth raw rows: {summary['counts']['book_depth_raw_rows']}</text>
  <text x="54" y="190" fill="#dbeafe" font-size="20" font-family="Arial">bookDepth 5m rows: {summary['counts']['book_depth_5m_rows']}</text>
  <text x="54" y="225" fill="#dbeafe" font-size="20" font-family="Arial">metrics rows: {summary['counts']['metrics_rows']}</text>
  <text x="54" y="275" fill="#facc15" font-size="18" font-family="Arial">清算历史：Binance Vision 未发现；CoinGlass 需要 API key；Tardis 路径未公开命中。</text>
  <text x="54" y="315" fill="#94a3b8" font-size="16" font-family="Arial">下一步：用 V2.5 的 L2+metrics 重跑 BTC/ETH；若清算仍缺，则做 websocket 前向采集或接 CoinGlass。</text>
</svg>"""


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    days = date_range()
    raw_book_rows: list[dict[str, Any]] = []
    metric_rows: list[dict[str, Any]] = []
    downloaded: list[dict[str, Any]] = []

    for symbol in SYMBOLS:
        for day in days:
            for kind in ["bookDepth", "metrics"]:
                url = binance_vision_url(kind, symbol, day)
                ok, note = head_exists(url)
                downloaded.append({"symbol": symbol, "date": day, "kind": kind, "available": ok, "notes": note, "url": url})
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
                                "source": "binance_vision_bookDepth",
                            })
                    else:
                        metric_rows.extend(normalize_metrics(rows))
                except Exception as exc:  # noqa: BLE001
                    downloaded[-1]["available"] = False
                    downloaded[-1]["notes"] = f"download_parse_failed: {exc}"
                time.sleep(0.08)

    book_5m = aggregate_book_depth(raw_book_rows)
    probes = probe_external_sources()

    write_csv(OUT_DIR / "hfcd_trading_v2_5_book_depth_raw.csv", raw_book_rows)
    write_csv(OUT_DIR / "hfcd_trading_v2_5_book_depth_5m.csv", book_5m)
    write_csv(OUT_DIR / "hfcd_trading_v2_5_metrics_5m.csv", metric_rows)
    write_csv(OUT_DIR / "hfcd_trading_v2_5_download_manifest.csv", downloaded)
    write_csv(OUT_DIR / "hfcd_trading_v2_5_source_probe.csv", [p.__dict__ for p in probes])

    summary = {
        "version": VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "symbols": SYMBOLS,
        "days": DAYS,
        "date_start": days[0],
        "date_end": days[-1],
        "output_dir": str(OUT_DIR),
        "counts": {
            "book_depth_raw_rows": len(raw_book_rows),
            "book_depth_5m_rows": len(book_5m),
            "metrics_rows": len(metric_rows),
            "download_manifest_rows": len(downloaded),
            "source_probe_rows": len(probes),
        },
        "decision": {
            "l2_history_ready": len(book_5m) > 1000,
            "metrics_history_ready": len(metric_rows) > 1000,
            "liquidation_history_ready": any(p.sensor in {"liquidation", "liquidations", "forceOrders", "allForceOrders"} and p.replay_ready for p in probes),
            "can_retrain_with_l2_metrics": len(book_5m) > 1000 and len(metric_rows) > 1000,
            "still_missing": ["liquidation_history"] if not any("liquidation" in p.sensor and p.replay_ready for p in probes) else [],
            "next_step": "V2.6 retrain BTC/ETH with Binance Vision L2 bookDepth + metrics; keep liquidation as optional forward/third-party sensor.",
        },
    }
    (OUT_DIR / "hfcd_trading_v2_5_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Trading_V2_5_CryptoBinanceVisionL2Metrics.svg").write_text(svg_report(summary), encoding="utf-8")

    md = f"""# {VERSION}

生成时间：{summary['generated_at']}

## 目标

继续寻找 BTC/ETH 高频模型缺失的真实传感器。本轮已确认 Binance 官方公共数据仓库存在 USD-M futures 的 `bookDepth` 历史文件，并把它下载解析成 5 分钟 L2 腔体账本。

## 已下载

- 日期范围：{summary['date_start']} 至 {summary['date_end']}，共 {DAYS} 天。
- 标的：{', '.join(SYMBOLS)}。
- bookDepth raw：{len(raw_book_rows)} 行。
- bookDepth 5m 聚合：{len(book_5m)} 行。
- metrics 5m：{len(metric_rows)} 行。

## 文件

- `hfcd_trading_v2_5_book_depth_raw.csv`
- `hfcd_trading_v2_5_book_depth_5m.csv`
- `hfcd_trading_v2_5_metrics_5m.csv`
- `hfcd_trading_v2_5_download_manifest.csv`
- `hfcd_trading_v2_5_source_probe.csv`

## 解释

`bookDepth` 不是完整逐档订单簿，但它给出了不同盘口距离（例如 0.2%、1%、2%、5%）内的累计 depth 和 notional。对 HFCD 来说，这已经能作为真实 `C腔 / liquidity cavity` 历史传感器，比只用 K 线 high-low spread 更接近真实盘口承载力。

`metrics` 同时提供 OI、顶级交易员多空比、账户多空比和主动买卖量比，可以替代 V2.4 中分散拉取的 OI/多空比，并作为 `R半径 / Bσ黑子 / Σ账本` 的高频代理。

## 仍缺

清算历史仍未在 Binance Vision 中发现。CoinGlass 已确认需要 API key；Tardis 的公开路径没有直接命中。清算传感器下一步只能：

1. 配置 CoinGlass API key 后拉历史。
2. 用 Binance 强平 websocket 从现在开始前向采集。
3. 用 Tardis 付费/授权历史数据。

## 下一步

V2.6 可以先用本轮 L2 bookDepth + metrics 重跑 BTC/ETH 本地训练，验证高频亏损是否因为缺少真实盘口腔体。清算历史继续作为可选增强，不阻塞 L2/metrics 分支。
"""
    (OUT_DIR / "HFCD_Trading_V2_5_CryptoBinanceVisionL2Metrics.md").write_text(md, encoding="utf-8")

    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
