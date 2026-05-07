#!/usr/bin/env python3
"""HFCD Trading V2.23 Crypto Frequency Router Testnet Mirror.

This layer mirrors V2.22 main-route paper events to Binance Futures Testnet.
It intentionally does not send orders for shadow routes and refuses non-testnet
endpoints unless explicitly overridden.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import hmac
import importlib.util
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from decimal import Decimal, ROUND_DOWN
from pathlib import Path
from types import SimpleNamespace
from typing import Any


VERSION = "HFCD_Trading_V2_23_CryptoFrequencyRouterTestnetMirror"
ROOT = Path(__file__).resolve().parents[1]
V22_PATH = ROOT / "scripts" / "hfcd_trading_v2_22_crypto_frequency_router_forward_shadow.py"
V23_OUT_DIR = ROOT / "outputs" / "hfcd_trading_v2_23_crypto_frequency_router_testnet_mirror"

TESTNET_BASE_URL = "https://testnet.binancefuture.com"
TRADE_SYMBOLS = {"BTCUSDT", "ETHUSDT"}
SUPPORTED_MAIN_EVENTS = {"open", "close"}
QUANTITY_STEPS = {
    "BTCUSDT": Decimal("0.001"),
    "ETHUSDT": Decimal("0.001"),
}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(ts: datetime) -> str:
    return ts.isoformat().replace("+00:00", "Z")


def number(value: Any, digits: int = 8) -> float:
    try:
        return round(float(value), digits)
    except Exception:  # noqa: BLE001
        return 0.0


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def credential_status() -> dict[str, Any]:
    api_key = (
        os.getenv("BINANCE_TESTNET_API_KEY")
        or os.getenv("BINANCE_API_KEY")
        or ""
    )
    api_secret = (
        os.getenv("BINANCE_TESTNET_API_SECRET")
        or os.getenv("BINANCE_TESTNET_SECRET_KEY")
        or os.getenv("BINANCE_TESTNET_SECRET")
        or os.getenv("BINANCE_API_SECRET")
        or os.getenv("BINANCE_SECRET_KEY")
        or os.getenv("BINANCE_SECRET")
        or ""
    )
    return {
        "ready": bool(api_key and api_secret),
        "api_key_var_present": bool(api_key),
        "api_secret_var_present": bool(api_secret),
    }


def load_module(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load module from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def append_csv(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    exists = path.exists()
    fields = list(row.keys())
    with path.open("a", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        if not exists:
            writer.writeheader()
        writer.writerow(row)


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fields: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for key in row:
            if key not in seen:
                seen.add(key)
                fields.append(key)
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def event_identity(event: dict[str, Any]) -> str:
    payload = {
        "timestamp": event.get("timestamp"),
        "symbol": event.get("symbol"),
        "route": event.get("route"),
        "role": event.get("role"),
        "event": event.get("event"),
        "action": event.get("action"),
        "side": event.get("side"),
        "price": event.get("price"),
        "quantity": event.get("quantity"),
        "reason": event.get("reason"),
    }
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def quantize_quantity(symbol: str, quantity: Any) -> str:
    step = QUANTITY_STEPS.get(symbol, Decimal("0.001"))
    qty = Decimal(str(abs(float(quantity or 0.0))))
    if qty <= 0:
        return "0"
    units = (qty / step).to_integral_value(rounding=ROUND_DOWN)
    return str((units * step).normalize())


@dataclass
class BinanceCredentials:
    api_key: str
    api_secret: str


class BinanceFuturesTestnetClient:
    def __init__(self, credentials: BinanceCredentials, base_url: str, allow_non_testnet: bool = False):
        self.credentials = credentials
        self.base_url = base_url.rstrip("/")
        self.allow_non_testnet = allow_non_testnet
        if not allow_non_testnet and "testnet" not in self.base_url:
            raise RuntimeError("Refusing non-testnet Binance endpoint")

    def _signed_request(self, method: str, path: str, params: dict[str, Any] | None = None) -> Any:
        payload = dict(params or {})
        payload["timestamp"] = int(time.time() * 1000)
        payload["recvWindow"] = 5000
        query = urllib.parse.urlencode(payload, doseq=True)
        signature = hmac.new(
            self.credentials.api_secret.encode("utf-8"),
            query.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        signed_query = f"{query}&signature={signature}"
        url = f"{self.base_url}{path}"
        headers = {"X-MBX-APIKEY": self.credentials.api_key}
        if method.upper() == "GET":
            request = urllib.request.Request(f"{url}?{signed_query}", headers=headers, method="GET")
        else:
            request = urllib.request.Request(f"{url}?{signed_query}", headers=headers, method=method.upper())
        try:
            with urllib.request.urlopen(request, timeout=20) as resp:  # noqa: S310
                text = resp.read().decode("utf-8")
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(f"Binance HTTP {exc.code}: {body[:500]}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Binance network error: {exc.reason}") from exc

    def account(self) -> dict[str, Any]:
        return self._signed_request("GET", "/fapi/v2/account")

    def positions(self) -> list[dict[str, Any]]:
        rows = self._signed_request("GET", "/fapi/v2/positionRisk")
        return rows if isinstance(rows, list) else []

    def open_orders(self, symbol: str | None = None) -> list[dict[str, Any]]:
        params: dict[str, Any] = {}
        if symbol:
            params["symbol"] = symbol
        rows = self._signed_request("GET", "/fapi/v1/openOrders", params)
        return rows if isinstance(rows, list) else []

    def cancel_all_open_orders(self, symbol: str) -> dict[str, Any]:
        return self._signed_request("DELETE", "/fapi/v1/allOpenOrders", {"symbol": symbol})

    def market_order(
        self,
        *,
        symbol: str,
        side: str,
        quantity: str,
        reduce_only: bool,
        client_order_id: str,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "symbol": symbol,
            "side": side,
            "type": "MARKET",
            "quantity": quantity,
            "newClientOrderId": client_order_id,
        }
        if reduce_only:
            params["reduceOnly"] = "true"
        return self._signed_request("POST", "/fapi/v1/order", params)


def load_state() -> dict[str, Any]:
    path = V23_OUT_DIR / "hfcd_trading_v2_23_testnet_mirror_state.json"
    state = read_json(path)
    if not state:
        state = {"mirrored_event_ids": [], "orders_sent": 0, "orders_blocked": 0}
    return state


def save_state(state: dict[str, Any]) -> None:
    write_json(V23_OUT_DIR / "hfcd_trading_v2_23_testnet_mirror_state.json", state)


def sanitize_account(account: dict[str, Any]) -> dict[str, Any]:
    if not account:
        return {}
    keys = [
        "totalWalletBalance",
        "totalUnrealizedProfit",
        "totalMarginBalance",
        "availableBalance",
        "maxWithdrawAmount",
    ]
    return {key: account.get(key, "") for key in keys}


def summarize_positions(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        symbol = row.get("symbol")
        if symbol not in TRADE_SYMBOLS:
            continue
        amt = number(row.get("positionAmt"), 10)
        if abs(amt) <= 0:
            continue
        mark_price = number(row.get("markPrice"), 8)
        out.append({
            "symbol": symbol,
            "positionAmt": amt,
            "entryPrice": row.get("entryPrice", ""),
            "markPrice": row.get("markPrice", ""),
            "notional": round(abs(amt) * mark_price, 8),
            "unRealizedProfit": row.get("unRealizedProfit", ""),
            "liquidationPrice": row.get("liquidationPrice", ""),
            "leverage": row.get("leverage", ""),
        })
    return out


def position_amount_by_symbol(rows: list[dict[str, Any]]) -> dict[str, float]:
    out: dict[str, float] = {}
    for row in rows:
        symbol = row.get("symbol")
        if symbol in TRADE_SYMBOLS:
            out[symbol] = number(row.get("positionAmt"), 10)
    return out


def summarize_open_orders(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        symbol = row.get("symbol")
        if symbol not in TRADE_SYMBOLS:
            continue
        out.append({
            "symbol": symbol,
            "orderId": row.get("orderId", ""),
            "clientOrderId": row.get("clientOrderId", ""),
            "side": row.get("side", ""),
            "type": row.get("type", ""),
            "status": row.get("status", ""),
            "price": row.get("price", ""),
            "origQty": row.get("origQty", ""),
            "executedQty": row.get("executedQty", ""),
            "reduceOnly": row.get("reduceOnly", ""),
            "time": row.get("time", ""),
        })
    return out


def build_safety_report(
    *,
    action: str,
    account_snapshot: dict[str, Any],
    positions: list[dict[str, Any]],
    open_orders: list[dict[str, Any]],
    max_position_notional: float,
    errors: list[str],
    actions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    position_rows = summarize_positions(positions)
    open_order_rows = summarize_open_orders(open_orders)
    over_notional = [
        row for row in position_rows
        if number(row.get("notional"), 8) > max_position_notional
    ]
    risk_flags: list[str] = []
    if position_rows:
        risk_flags.append("open_positions_present")
    if open_order_rows:
        risk_flags.append("open_orders_present")
    if over_notional:
        risk_flags.append("position_notional_over_limit")
    if errors:
        risk_flags.append("audit_errors_present")
    return {
        "version": VERSION,
        "created_at": iso(now_utc()),
        "safety_action": action,
        "status": "risk_flags_present" if risk_flags else "clean",
        "risk_flags": risk_flags,
        "max_position_notional": max_position_notional,
        "account_snapshot": account_snapshot,
        "positions": position_rows,
        "open_orders": open_order_rows,
        "over_notional_positions": over_notional,
        "errors": errors,
        "actions": actions or [],
    }


def write_safety_report(report: dict[str, Any]) -> None:
    write_json(V23_OUT_DIR / "hfcd_trading_v2_23_safety_report.json", report)
    write_csv(V23_OUT_DIR / "hfcd_trading_v2_23_safety_positions.csv", report.get("positions", []))
    write_csv(V23_OUT_DIR / "hfcd_trading_v2_23_safety_open_orders.csv", report.get("open_orders", []))
    write_csv(V23_OUT_DIR / "hfcd_trading_v2_23_safety_actions.csv", report.get("actions", []))


def close_all_positions(
    *,
    client: BinanceFuturesTestnetClient,
    positions: list[dict[str, Any]],
    cancel_open_orders: bool,
) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    for symbol in sorted(TRADE_SYMBOLS):
        if cancel_open_orders:
            try:
                response = client.cancel_all_open_orders(symbol)
                actions.append({
                    "timestamp": iso(now_utc()),
                    "action": "cancel_all_open_orders",
                    "symbol": symbol,
                    "status": "sent",
                    "response": json.dumps(response, ensure_ascii=False),
                    "error": "",
                })
            except Exception as exc:  # noqa: BLE001
                actions.append({
                    "timestamp": iso(now_utc()),
                    "action": "cancel_all_open_orders",
                    "symbol": symbol,
                    "status": "failed",
                    "response": "",
                    "error": str(exc),
                })

    for row in summarize_positions(positions):
        symbol = str(row.get("symbol", ""))
        amt = number(row.get("positionAmt"), 10)
        qty = quantize_quantity(symbol, abs(amt))
        if qty == "0":
            actions.append({
                "timestamp": iso(now_utc()),
                "action": "close_position",
                "symbol": symbol,
                "side": "",
                "quantity": qty,
                "status": "blocked_quantity_under_min",
                "response": "",
                "error": "",
            })
            continue
        side = "SELL" if amt > 0 else "BUY"
        client_order_id = f"HFCDV223SAFE{hashlib.sha256(f'{symbol}{amt}{time.time()}'.encode()).hexdigest()[:18]}"
        try:
            response = client.market_order(
                symbol=symbol,
                side=side,
                quantity=qty,
                reduce_only=True,
                client_order_id=client_order_id,
            )
            actions.append({
                "timestamp": iso(now_utc()),
                "action": "close_position",
                "symbol": symbol,
                "side": side,
                "quantity": qty,
                "client_order_id": client_order_id,
                "status": "sent",
                "response": json.dumps(response, ensure_ascii=False),
                "error": "",
            })
        except Exception as exc:  # noqa: BLE001
            actions.append({
                "timestamp": iso(now_utc()),
                "action": "close_position",
                "symbol": symbol,
                "side": side,
                "quantity": qty,
                "client_order_id": client_order_id,
                "status": "failed",
                "response": "",
                "error": str(exc),
            })
    return actions


def mirror_event(
    event: dict[str, Any],
    *,
    client: BinanceFuturesTestnetClient | None,
    positions_by_symbol: dict[str, float],
    state: dict[str, Any],
    order_mode: str,
    credentials_ready: bool,
) -> dict[str, Any]:
    ts = iso(now_utc())
    event_id = event_identity(event)
    symbol = str(event.get("symbol", ""))
    role = str(event.get("role", ""))
    event_type = str(event.get("event", ""))
    side = str(event.get("side", ""))
    quantity = quantize_quantity(symbol, event.get("quantity"))
    client_order_id = f"HFCDV223{event_id[:24]}"
    base = {
        "timestamp": ts,
        "source_event_timestamp": event.get("timestamp", ""),
        "event_id": event_id,
        "symbol": symbol,
        "route": event.get("route", ""),
        "role": role,
        "source_event": event_type,
        "source_action": event.get("action", ""),
        "source_side": side,
        "source_price": event.get("price", ""),
        "source_quantity": event.get("quantity", ""),
        "testnet_quantity": quantity,
        "client_order_id": client_order_id,
        "order_mode": order_mode,
        "mirror_status": "",
        "binance_order_id": "",
        "binance_status": "",
        "order_side": "",
        "reduce_only": False,
        "error": "",
    }

    if role != "main":
        return {**base, "mirror_status": "shadow_route_no_testnet_order"}
    if event_type not in SUPPORTED_MAIN_EVENTS:
        return {**base, "mirror_status": "main_non_execution_event_no_order"}
    if event_id in set(state.get("mirrored_event_ids", [])):
        return {**base, "mirror_status": "duplicate_event_skipped"}
    if quantity == "0":
        state["orders_blocked"] = int(state.get("orders_blocked", 0)) + 1
        return {**base, "mirror_status": "blocked_quantity_under_min"}
    if order_mode in {"dry_run", "audit"}:
        return {**base, "mirror_status": f"{order_mode}_no_order_sent"}
    if not credentials_ready or client is None:
        state["orders_blocked"] = int(state.get("orders_blocked", 0)) + 1
        return {**base, "mirror_status": "blocked_missing_testnet_credentials"}

    if event_type == "open":
        if side == "long":
            order_side = "BUY"
        elif side == "short":
            order_side = "SELL"
        else:
            state["orders_blocked"] = int(state.get("orders_blocked", 0)) + 1
            return {**base, "mirror_status": "blocked_unknown_open_side"}
        reduce_only = False
    else:
        pos_amt = positions_by_symbol.get(symbol, 0.0)
        if abs(pos_amt) <= 0:
            state["orders_blocked"] = int(state.get("orders_blocked", 0)) + 1
            return {**base, "mirror_status": "blocked_no_testnet_position_to_reduce"}
        if side == "long":
            order_side = "SELL"
        elif side == "short":
            order_side = "BUY"
        else:
            order_side = "SELL" if pos_amt > 0 else "BUY"
        reduce_only = True
        quantity = quantize_quantity(symbol, min(abs(float(quantity)), abs(pos_amt)))
        if quantity == "0":
            state["orders_blocked"] = int(state.get("orders_blocked", 0)) + 1
            return {**base, "mirror_status": "blocked_position_quantity_under_min"}

    try:
        response = client.market_order(
            symbol=symbol,
            side=order_side,
            quantity=quantity,
            reduce_only=reduce_only,
            client_order_id=client_order_id,
        )
        state.setdefault("mirrored_event_ids", []).append(event_id)
        state["orders_sent"] = int(state.get("orders_sent", 0)) + 1
        return {
            **base,
            "testnet_quantity": quantity,
            "mirror_status": "testnet_order_sent",
            "binance_order_id": response.get("orderId", ""),
            "binance_status": response.get("status", ""),
            "order_side": order_side,
            "reduce_only": reduce_only,
        }
    except Exception as exc:  # noqa: BLE001
        state["orders_blocked"] = int(state.get("orders_blocked", 0)) + 1
        return {
            **base,
            "testnet_quantity": quantity,
            "mirror_status": "testnet_order_failed",
            "order_side": order_side,
            "reduce_only": reduce_only,
            "error": str(exc),
        }


def render_report(summary: dict[str, Any]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 本轮状态：`{summary['status']}`。",
        f"- Binance Futures Testnet 凭证状态：`{summary['testnet_credentials_status']}`。",
        f"- 订单模式：`{summary['order_mode']}`；主网保护：`{summary['mainnet_protection']}`。",
        f"- V2.23 主路由方向策略：`{summary['main_side_policy']}`。",
        f"- 本轮发送 Testnet 订单：`{summary['orders_sent_this_cycle']}`；阻断：`{summary['orders_blocked_this_cycle']}`。",
        f"- 安全审计状态：`{summary.get('safety_report', {}).get('status', '-')}`；风险标记：`{', '.join(summary.get('safety_report', {}).get('risk_flags', [])) or '-'}`。",
        "- main 路由才允许镜像 testnet；shadow 路由只记录。",
        "- V2.23 默认允许 main 路由做多/做空；V2.22 原始脚本不被改写。",
        "- 行情与信号仍来自 V2.22 的真实 Binance 公共数据频率路由。",
        "",
        "## 最新 Testnet 镜像事件",
        "",
    ]
    for row in summary["latest_mirror_events"]:
        lines.append(
            f"- `{row['symbol']}` `{row['route']}` `{row['source_event']}` "
            f"role={row['role']} status=`{row['mirror_status']}` "
            f"qty={row['testnet_quantity']} side={row['order_side'] or '-'} "
            f"error=`{row['error'] or '-'}`。"
        )
    lines.extend([
        "",
        "## 风控边界",
        "",
        "- 该层只连接 Binance Futures Testnet，不连接真实主网。",
        "- 如果 V2.22 最新事件是 skip/hold，则不会发送订单。",
        "- 如果本地 paper close 事件出现但 Testnet 没有对应仓位，会阻断 reduce-only 平仓。",
        "- 每轮都会写出 `safety_report`；可用 `--safety-action reconcile` 单独对账，用 `--safety-action close-all --cancel-open-orders` 执行 Testnet reduce-only 清仓。",
        "- 该层用于验证执行闭环、订单失败率、仓位对账，不用于证明策略盈利。",
    ])
    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=VERSION)
    parser.add_argument("--cycles", type=int, default=1, help="1=one shot, 0=run forever")
    parser.add_argument("--interval-minutes", type=float, default=15.0)
    parser.add_argument("--liquidation-seconds", type=int, default=8)
    parser.add_argument(
        "--order-mode",
        choices=["signal", "dry_run", "audit"],
        default="signal",
        help="signal sends testnet orders only for V2.22 main open/close events",
    )
    parser.add_argument(
        "--main-side-policy",
        choices=["both", "preserve", "long_only", "short_only"],
        default="both",
        help="V2.23-only side-policy override for enabled main routes",
    )
    parser.add_argument("--base-url", default=os.getenv("BINANCE_FUTURES_TESTNET_BASE_URL", TESTNET_BASE_URL))
    parser.add_argument("--allow-non-testnet", action="store_true")
    parser.add_argument(
        "--safety-action",
        choices=["mirror", "reconcile", "close-all"],
        default="mirror",
        help="mirror=normal route mirror, reconcile=account/position audit only, close-all=reduce-only close BTC/ETH testnet positions",
    )
    parser.add_argument("--max-position-notional", type=float, default=2500.0)
    parser.add_argument("--cancel-open-orders", action="store_true")
    return parser.parse_args()


def make_client(args: argparse.Namespace) -> tuple[BinanceFuturesTestnetClient | None, dict[str, Any], str]:
    load_env_file(ROOT / ".env.local")
    status = credential_status()
    if not status["ready"]:
        return None, status, "missing"
    key = os.getenv("BINANCE_TESTNET_API_KEY") or os.getenv("BINANCE_API_KEY") or ""
    secret = (
        os.getenv("BINANCE_TESTNET_API_SECRET")
        or os.getenv("BINANCE_TESTNET_SECRET_KEY")
        or os.getenv("BINANCE_TESTNET_SECRET")
        or os.getenv("BINANCE_API_SECRET")
        or os.getenv("BINANCE_SECRET_KEY")
        or os.getenv("BINANCE_SECRET")
        or ""
    )
    try:
        client = BinanceFuturesTestnetClient(
            BinanceCredentials(api_key=key, api_secret=secret),
            args.base_url,
            allow_non_testnet=args.allow_non_testnet,
        )
        return client, status, "ready"
    except Exception as exc:  # noqa: BLE001
        status["client_error"] = str(exc)
        return None, status, "client_blocked"


def run_cycle(args: argparse.Namespace) -> dict[str, Any]:
    V23_OUT_DIR.mkdir(parents=True, exist_ok=True)
    started = now_utc()
    v22 = load_module("hfcd_v2_22_for_v23", V22_PATH)
    route_overrides: list[dict[str, Any]] = []
    if args.main_side_policy != "preserve":
        for idx, route in enumerate(v22.ROUTES):
            if getattr(route, "enabled", False) and getattr(route, "role", "") == "main":
                old_policy = getattr(route, "side_policy", "")
                v22.ROUTES[idx] = replace(route, side_policy=args.main_side_policy)
                route_overrides.append({
                    "symbol": route.symbol,
                    "route": route.route,
                    "role": route.role,
                    "old_side_policy": old_policy,
                    "new_side_policy": args.main_side_policy,
                })
    v22_args = SimpleNamespace(
        cycles=1,
        interval_minutes=args.interval_minutes,
        liquidation_seconds=args.liquidation_seconds,
    )
    before_state = load_state()
    before_orders_sent = int(before_state.get("orders_sent", 0))
    before_orders_blocked = int(before_state.get("orders_blocked", 0))

    v22_summary = v22.run_cycle(v22_args)
    state = load_state()
    client, cred_detail, cred_status = make_client(args)

    account_snapshot: dict[str, Any] = {}
    positions: list[dict[str, Any]] = []
    account_audit_error = ""
    if client is not None:
        try:
            account_snapshot = sanitize_account(client.account())
            positions = client.positions()
        except Exception as exc:  # noqa: BLE001
            account_audit_error = str(exc)

    positions_by_symbol = position_amount_by_symbol(positions)
    pre_position_rows = summarize_positions(positions)
    latest_events = list(v22_summary.get("latest_events", []))
    mirror_rows: list[dict[str, Any]] = []
    for event in latest_events:
        row = mirror_event(
            event,
            client=client if not account_audit_error else None,
            positions_by_symbol=positions_by_symbol,
            state=state,
            order_mode=args.order_mode,
            credentials_ready=cred_status == "ready" and not account_audit_error,
        )
        mirror_rows.append(row)
        append_csv(V23_OUT_DIR / "hfcd_trading_v2_23_mirror_events.csv", row)

    save_state(state)
    post_account_snapshot = account_snapshot
    post_positions = positions
    post_account_audit_error = ""
    if client is not None and not account_audit_error:
        try:
            post_account_snapshot = sanitize_account(client.account())
            post_positions = client.positions()
        except Exception as exc:  # noqa: BLE001
            post_account_audit_error = str(exc)

    position_rows = summarize_positions(post_positions)
    open_orders: list[dict[str, Any]] = []
    open_order_error = ""
    if client is not None and not account_audit_error:
        for symbol in sorted(TRADE_SYMBOLS):
            try:
                open_orders.extend(client.open_orders(symbol))
            except Exception as exc:  # noqa: BLE001
                open_order_error = f"{symbol}: {exc}"
    write_csv(V23_OUT_DIR / "hfcd_trading_v2_23_latest_mirror_events.csv", mirror_rows)
    write_csv(V23_OUT_DIR / "hfcd_trading_v2_23_position_snapshot.csv", position_rows)
    write_json(V23_OUT_DIR / "hfcd_trading_v2_23_account_snapshot.json", post_account_snapshot)
    safety_errors = [
        msg for msg in [account_audit_error, post_account_audit_error, open_order_error] if msg
    ]
    safety_report = build_safety_report(
        action="mirror",
        account_snapshot=post_account_snapshot,
        positions=post_positions,
        open_orders=open_orders,
        max_position_notional=args.max_position_notional,
        errors=safety_errors,
    )
    write_safety_report(safety_report)

    orders_sent_now = int(state.get("orders_sent", 0)) - before_orders_sent
    orders_blocked_now = int(state.get("orders_blocked", 0)) - before_orders_blocked
    status = "testnet_mirror_cycle_completed"
    if cred_status != "ready":
        status = "testnet_mirror_completed_credentials_not_ready"
    if account_audit_error:
        status = "testnet_mirror_completed_account_audit_failed"

    summary = {
        "version": VERSION,
        "created_at": iso(started),
        "finished_at": iso(now_utc()),
        "status": status,
        "order_mode": args.order_mode,
        "main_side_policy": args.main_side_policy,
        "v2_23_route_overrides": route_overrides,
        "uses_real_public_market_data": True,
        "uses_v2_22_frequency_router": True,
        "uses_binance_futures_testnet": cred_status == "ready",
        "testnet_credentials_status": cred_status,
        "testnet_credentials_detail": cred_detail,
        "testnet_base_url": args.base_url,
        "mainnet_protection": "enabled" if not args.allow_non_testnet else "disabled_by_flag",
        "account_audit_error": account_audit_error,
        "post_order_account_audit_error": post_account_audit_error,
        "orders_sent_this_cycle": orders_sent_now,
        "orders_blocked_this_cycle": orders_blocked_now,
        "orders_sent_total": int(state.get("orders_sent", 0)),
        "orders_blocked_total": int(state.get("orders_blocked", 0)),
        "shadow_routes_not_ordered": True,
        "v22_status": v22_summary.get("status", ""),
        "v22_historical_liquidation_status": v22_summary.get("historical_liquidation_status", ""),
        "latest_v22_events": latest_events,
        "latest_mirror_events": mirror_rows,
        "account_snapshot": post_account_snapshot,
        "pre_position_snapshot": pre_position_rows,
        "position_snapshot": position_rows,
        "safety_report": safety_report,
        "files": {
            "summary": str(V23_OUT_DIR / "hfcd_trading_v2_23_summary.json"),
            "report": str(V23_OUT_DIR / "HFCD_Trading_V2_23_CryptoFrequencyRouterTestnetMirror.md"),
            "mirror_events": str(V23_OUT_DIR / "hfcd_trading_v2_23_mirror_events.csv"),
            "latest_mirror_events": str(V23_OUT_DIR / "hfcd_trading_v2_23_latest_mirror_events.csv"),
            "account_snapshot": str(V23_OUT_DIR / "hfcd_trading_v2_23_account_snapshot.json"),
            "position_snapshot": str(V23_OUT_DIR / "hfcd_trading_v2_23_position_snapshot.csv"),
            "safety_report": str(V23_OUT_DIR / "hfcd_trading_v2_23_safety_report.json"),
            "state": str(V23_OUT_DIR / "hfcd_trading_v2_23_testnet_mirror_state.json"),
            "v22_summary": str(v22.OUT_DIR / "hfcd_trading_v2_22_summary.json"),
        },
    }
    write_json(V23_OUT_DIR / "hfcd_trading_v2_23_summary.json", summary)
    (V23_OUT_DIR / "HFCD_Trading_V2_23_CryptoFrequencyRouterTestnetMirror.md").write_text(
        render_report(summary),
        encoding="utf-8",
    )
    return summary


def run_safety_action(args: argparse.Namespace) -> dict[str, Any]:
    V23_OUT_DIR.mkdir(parents=True, exist_ok=True)
    client, cred_detail, cred_status = make_client(args)
    errors: list[str] = []
    actions: list[dict[str, Any]] = []
    account_snapshot: dict[str, Any] = {}
    positions: list[dict[str, Any]] = []
    open_orders: list[dict[str, Any]] = []

    if cred_status != "ready" or client is None:
        errors.append(f"testnet_credentials_not_ready: {cred_detail}")
    else:
        try:
            account_snapshot = sanitize_account(client.account())
        except Exception as exc:  # noqa: BLE001
            errors.append(f"account_error: {exc}")
        try:
            positions = client.positions()
        except Exception as exc:  # noqa: BLE001
            errors.append(f"position_error: {exc}")
        for symbol in sorted(TRADE_SYMBOLS):
            try:
                open_orders.extend(client.open_orders(symbol))
            except Exception as exc:  # noqa: BLE001
                errors.append(f"open_orders_error_{symbol}: {exc}")

        if args.safety_action == "close-all":
            actions = close_all_positions(
                client=client,
                positions=positions,
                cancel_open_orders=args.cancel_open_orders,
            )
            try:
                account_snapshot = sanitize_account(client.account())
                positions = client.positions()
                open_orders = []
                for symbol in sorted(TRADE_SYMBOLS):
                    open_orders.extend(client.open_orders(symbol))
            except Exception as exc:  # noqa: BLE001
                errors.append(f"post_close_audit_error: {exc}")

    report = build_safety_report(
        action=args.safety_action,
        account_snapshot=account_snapshot,
        positions=positions,
        open_orders=open_orders,
        max_position_notional=args.max_position_notional,
        errors=errors,
        actions=actions,
    )
    report["testnet_credentials_status"] = cred_status
    report["testnet_credentials_detail"] = cred_detail
    report["testnet_base_url"] = args.base_url
    report["mainnet_protection"] = "enabled" if not args.allow_non_testnet else "disabled_by_flag"
    write_safety_report(report)
    return report


def main() -> None:
    args = parse_args()
    if args.safety_action in {"reconcile", "close-all"}:
        report = run_safety_action(args)
        print(json.dumps({
            "version": VERSION,
            "safety_action": args.safety_action,
            "status": report["status"],
            "risk_flags": report["risk_flags"],
            "positions": report["positions"],
            "open_orders": report["open_orders"],
            "actions": report["actions"],
            "output_dir": str(V23_OUT_DIR),
        }, ensure_ascii=False, indent=2))
        return

    cycle = 0
    while True:
        cycle += 1
        summary = run_cycle(args)
        print(json.dumps({
            "version": VERSION,
            "cycle": cycle,
            "status": summary["status"],
            "order_mode": summary["order_mode"],
            "main_side_policy": summary["main_side_policy"],
            "testnet_credentials_status": summary["testnet_credentials_status"],
            "orders_sent_this_cycle": summary["orders_sent_this_cycle"],
            "orders_blocked_this_cycle": summary["orders_blocked_this_cycle"],
            "mirror_events": [
                {
                    "symbol": row["symbol"],
                    "route": row["route"],
                    "role": row["role"],
                    "source_event": row["source_event"],
                    "mirror_status": row["mirror_status"],
                    "error": row["error"],
                }
                for row in summary["latest_mirror_events"]
            ],
            "output_dir": str(V23_OUT_DIR),
        }, ensure_ascii=False, indent=2))
        if args.cycles > 0 and cycle >= args.cycles:
            break
        time.sleep(max(1.0, float(args.interval_minutes) * 60.0))


if __name__ == "__main__":
    main()
