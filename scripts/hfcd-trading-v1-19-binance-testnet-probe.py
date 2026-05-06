#!/usr/bin/env python3
"""
HFCD Trading V1.19 Binance Testnet Probe

This stage validates that the trading interface layer can reach Binance
testnet public and signed endpoints. It never sends a real market order.
The optional /order/test checks are disabled unless HFCD_BINANCE_TEST_ORDER=1.
"""

from __future__ import annotations

import csv
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


VERSION = "HFCD_Trading_V1_19_BinanceTestnetProbe"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_19_binance_testnet_probe"
SPOT_BASE = os.environ.get("BINANCE_SPOT_TESTNET_BASE", "https://testnet.binance.vision")
FUTURES_BASE = os.environ.get("BINANCE_FUTURES_TESTNET_BASE", "https://testnet.binancefuture.com")


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
        for key in row:
            if key not in fieldnames:
                fieldnames.append(key)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def http_json(method: str, url: str, headers: dict[str, str] | None = None, body: bytes | None = None) -> tuple[int, Any, str]:
    request = urllib.request.Request(url, headers=headers or {}, method=method, data=body)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read().decode("utf-8", errors="replace")
            try:
                return int(response.status), json.loads(raw), raw[:500]
            except json.JSONDecodeError:
                return int(response.status), {}, raw[:500]
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {}
        return int(exc.code), payload, raw[:500]
    except Exception as exc:
        return 0, {"error": f"{type(exc).__name__}: {exc}"}, str(exc)[:500]


def sign_query(secret: str, params: dict[str, Any]) -> str:
    query = urllib.parse.urlencode(params)
    signature = hmac.new(secret.encode("utf-8"), query.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{query}&signature={signature}"


def signed_get(base: str, path: str, key: str, secret: str, params: dict[str, Any] | None = None) -> tuple[int, Any, str]:
    params = dict(params or {})
    params.setdefault("timestamp", int(time.time() * 1000))
    query = sign_query(secret, params)
    return http_json("GET", f"{base}{path}?{query}", headers={"X-MBX-APIKEY": key})


def signed_post(base: str, path: str, key: str, secret: str, params: dict[str, Any]) -> tuple[int, Any, str]:
    params = dict(params)
    params.setdefault("timestamp", int(time.time() * 1000))
    query = sign_query(secret, params)
    return http_json("POST", f"{base}{path}?{query}", headers={"X-MBX-APIKEY": key})


def summarize_payload(endpoint: str, status: int, payload: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"endpoint": endpoint, "http_status": status, "ok": 200 <= status < 300}
    if isinstance(payload, dict):
        if "serverTime" in payload:
            out["server_time"] = payload.get("serverTime")
        if "symbols" in payload and isinstance(payload.get("symbols"), list):
            out["symbols_count"] = len(payload["symbols"])
        if "balances" in payload and isinstance(payload.get("balances"), list):
            out["balances_count"] = len(payload["balances"])
        if "assets" in payload and isinstance(payload.get("assets"), list):
            out["assets_count"] = len(payload["assets"])
        if "positions" in payload and isinstance(payload.get("positions"), list):
            out["positions_count"] = len(payload["positions"])
        if "code" in payload:
            out["error_code"] = payload.get("code")
        if "msg" in payload:
            out["message"] = str(payload.get("msg"))[:240]
        if "error" in payload:
            out["message"] = str(payload.get("error"))[:240]
    return out


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    load_env_file(ROOT / ".env.local")
    load_env_file(ROOT / ".dev.vars")

    key = os.environ.get("BINANCE_TESTNET_API_KEY", "").strip()
    secret = os.environ.get("BINANCE_TESTNET_API_SECRET", "").strip()
    allow_test_order = os.environ.get("HFCD_BINANCE_TEST_ORDER", "0") == "1"
    checks: list[dict[str, Any]] = []

    public_calls = [
        ("spot_time", "GET", f"{SPOT_BASE}/api/v3/time"),
        ("spot_exchange_info_btcusdt", "GET", f"{SPOT_BASE}/api/v3/exchangeInfo?symbol=BTCUSDT"),
        ("futures_time", "GET", f"{FUTURES_BASE}/fapi/v1/time"),
        ("futures_exchange_info", "GET", f"{FUTURES_BASE}/fapi/v1/exchangeInfo"),
    ]
    for name, method, url in public_calls:
        status, payload, _ = http_json(method, url)
        row = summarize_payload(name, status, payload)
        row["requires_signature"] = False
        checks.append(row)

    signed_ready = bool(key and secret)
    if signed_ready:
        for name, base, path in [
            ("spot_account_signed", SPOT_BASE, "/api/v3/account"),
            ("futures_account_signed", FUTURES_BASE, "/fapi/v2/account"),
        ]:
            status, payload, _ = signed_get(base, path, key, secret, {"recvWindow": 5000})
            row = summarize_payload(name, status, payload)
            row["requires_signature"] = True
            checks.append(row)

        if allow_test_order:
            status, payload, _ = signed_post(
                SPOT_BASE,
                "/api/v3/order/test",
                key,
                secret,
                {"symbol": "BTCUSDT", "side": "BUY", "type": "MARKET", "quoteOrderQty": "10", "recvWindow": 5000},
            )
            row = summarize_payload("spot_order_test_signed", status, payload)
            row["requires_signature"] = True
            row["test_order_enabled"] = True
            checks.append(row)
            status, payload, _ = signed_post(
                FUTURES_BASE,
                "/fapi/v1/order/test",
                key,
                secret,
                {"symbol": "BTCUSDT", "side": "BUY", "type": "MARKET", "quantity": "0.001", "recvWindow": 5000},
            )
            row = summarize_payload("futures_order_test_signed", status, payload)
            row["requires_signature"] = True
            row["test_order_enabled"] = True
            checks.append(row)
        else:
            checks.append(
                {
                    "endpoint": "spot_order_test_signed",
                    "http_status": "",
                    "ok": False,
                    "requires_signature": True,
                    "test_order_enabled": False,
                    "message": "skipped_by_default_set_HFCD_BINANCE_TEST_ORDER_1_to_enable_test_endpoint",
                }
            )
            checks.append(
                {
                    "endpoint": "futures_order_test_signed",
                    "http_status": "",
                    "ok": False,
                    "requires_signature": True,
                    "test_order_enabled": False,
                    "message": "skipped_by_default_set_HFCD_BINANCE_TEST_ORDER_1_to_enable_test_endpoint",
                }
            )
    else:
        checks.append(
            {
                "endpoint": "signed_endpoints",
                "http_status": "",
                "ok": False,
                "requires_signature": True,
                "message": "missing_BINANCE_TESTNET_API_KEY_or_BINANCE_TESTNET_API_SECRET",
            }
        )

    public_ok = all(row["ok"] for row in checks if not row.get("requires_signature"))
    spot_signed_ok = signed_ready and any(row["endpoint"] == "spot_account_signed" and row["ok"] for row in checks)
    futures_signed_ok = signed_ready and any(row["endpoint"] == "futures_account_signed" and row["ok"] for row in checks)
    signed_ok = spot_signed_ok or futures_signed_ok
    if public_ok and futures_signed_ok and not spot_signed_ok:
        status = "futures_testnet_signed_probe_pass_spot_blocked"
    elif public_ok and spot_signed_ok and futures_signed_ok:
        status = "spot_and_futures_signed_probe_pass"
    elif public_ok:
        status = "public_probe_pass_signed_blocked"
    else:
        status = "probe_failed"
    summary = {
        "version": VERSION,
        "mode": "testnet_probe_not_live_trading",
        "spot_base": SPOT_BASE,
        "futures_base": FUTURES_BASE,
        "key_loaded": bool(key),
        "secret_loaded": bool(secret),
        "public_ok": public_ok,
        "spot_signed_account_ok": spot_signed_ok,
        "futures_signed_account_ok": futures_signed_ok,
        "any_signed_account_ok": signed_ok,
        "test_order_enabled": allow_test_order,
        "checks_count": len(checks),
        "status": status,
        "note": "No real order is sent. /order/test is disabled unless explicitly enabled by env.",
    }

    write_csv(OUT_DIR / "hfcd_trading_v1_19_binance_testnet_probe_checks.csv", checks)
    (OUT_DIR / "hfcd_trading_v1_19_binance_testnet_probe_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    md = [
        f"# {VERSION}",
        "",
        "本阶段只验证 Binance 测试网交易接口连通性，不连接真实交易所账户，不发送真实订单。",
        "",
        f"- 公共行情接口：{'通过' if public_ok else '未通过'}",
        f"- API key 已加载：{'是' if summary['key_loaded'] else '否'}",
        f"- API secret 已加载：{'是' if summary['secret_loaded'] else '否'}",
        f"- Spot 签名账户接口：{'通过' if spot_signed_ok else '未通过或未配置'}",
        f"- Futures 签名账户接口：{'通过' if futures_signed_ok else '未通过或未配置'}",
        f"- `/order/test`：{'已启用' if allow_test_order else '默认跳过'}",
        f"- 状态：`{summary['status']}`",
        "",
        "输出文件：",
        f"- `{OUT_DIR / 'hfcd_trading_v1_19_binance_testnet_probe_checks.csv'}`",
        f"- `{OUT_DIR / 'hfcd_trading_v1_19_binance_testnet_probe_summary.json'}`",
    ]
    (OUT_DIR / "HFCD_Trading_V1_19_BinanceTestnetProbe.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
