#!/usr/bin/env python3
"""HFCD Trading V2.13: Crypto forward daemon + liquidation tape.

Local-only runner. It wraps V2.12 one-shot forward paper shadow and adds a
Binance USD-M liquidation tape collector plus daily health audit files.

Default invocation runs one short cycle for validation. For a local daemon:

  python3 scripts/hfcd_trading_v2_13_crypto_forward_daemon_liquidation_tape.py \
    --cycles 0 --interval-minutes 15 --liquidation-seconds 60

No account credentials are used. No real orders are sent.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import importlib.util
import json
import os
import socket
import ssl
import struct
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd


VERSION = "HFCD_Trading_V2_13_CryptoForwardDaemonLiquidationTape"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v2_13_crypto_forward_daemon_liquidation_tape"
V12_DIR = ROOT / "outputs" / "hfcd_trading_v2_12_crypto_forward_paper_shadow"
V12_PATH = ROOT / "scripts" / "hfcd_trading_v2_12_crypto_forward_paper_shadow.py"
SYMBOLS = {"BTCUSDT", "ETHUSDT"}
FORCE_ORDER_HOST = "fstream.binance.com"
FORCE_ORDER_PATH = "/ws/!forceOrder@arr"


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def number(value: float, digits: int = 6) -> float:
    try:
        return round(float(value or 0.0), digits)
    except Exception:
        return 0.0


def ensure_out() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)


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


def load_v12():
    spec = importlib.util.spec_from_file_location("hfcd_v2_12", V12_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load V2.12 module: {V12_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["hfcd_v2_12"] = module
    spec.loader.exec_module(module)
    return module


class MinimalWebSocket:
    """Small RFC6455 client for one Binance public stream."""

    def __init__(self, host: str, path: str, timeout: float = 5.0) -> None:
        self.host = host
        self.path = path
        self.timeout = timeout
        self.sock: ssl.SSLSocket | None = None

    def connect(self) -> None:
        raw = socket.create_connection((self.host, 443), timeout=self.timeout)
        raw.settimeout(self.timeout)
        self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=self.host)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "User-Agent: HFCD-ThingNature-OS/2.13\r\n"
            "\r\n"
        )
        self.sock.sendall(req.encode("ascii"))
        response = self._recv_until(b"\r\n\r\n")
        if b" 101 " not in response.split(b"\r\n", 1)[0]:
            raise RuntimeError(f"websocket handshake failed: {response[:160]!r}")
        expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
        if expected not in response:
            raise RuntimeError("websocket accept key mismatch")

    def _recv_until(self, marker: bytes) -> bytes:
        assert self.sock is not None
        buf = b""
        while marker not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("socket closed during handshake")
            buf += chunk
        return buf

    def _recv_exact(self, n: int) -> bytes:
        assert self.sock is not None
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise RuntimeError("socket closed")
            buf += chunk
        return buf

    def read_text(self) -> str | None:
        header = self._recv_exact(2)
        b1, b2 = header[0], header[1]
        opcode = b1 & 0x0F
        masked = bool(b2 & 0x80)
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._recv_exact(8))[0]
        mask = self._recv_exact(4) if masked else b""
        payload = self._recv_exact(length) if length else b""
        if masked:
            payload = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))
        if opcode == 0x1:
            return payload.decode("utf-8", "ignore")
        if opcode == 0x8:
            return None
        if opcode == 0x9:
            self.send_pong(payload)
            return ""
        return ""

    def send_pong(self, payload: bytes = b"") -> None:
        self._send_control(0xA, payload)

    def _send_control(self, opcode: int, payload: bytes) -> None:
        assert self.sock is not None
        mask = os.urandom(4)
        header = bytes([0x80 | opcode, 0x80 | len(payload)])
        masked = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))
        self.sock.sendall(header + mask + masked)

    def close(self) -> None:
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
            self.sock = None


def liquidation_row(payload: dict[str, Any], received_at: datetime) -> dict[str, Any] | None:
    order = payload.get("o") if isinstance(payload, dict) else None
    if not isinstance(order, dict):
        return None
    symbol = str(order.get("s", ""))
    if symbol not in SYMBOLS:
        return None
    qty = number(order.get("q"), 8)
    avg_price = number(order.get("ap") or order.get("p"), 8)
    notional = number(qty * avg_price, 4)
    event_ms = int(payload.get("E") or order.get("T") or 0)
    event_time = datetime.fromtimestamp(event_ms / 1000, timezone.utc) if event_ms else received_at
    return {
        "received_at": iso(received_at),
        "event_time": iso(event_time),
        "symbol": symbol,
        "side": order.get("S", ""),
        "order_type": order.get("o", ""),
        "time_in_force": order.get("f", ""),
        "status": order.get("X", ""),
        "price": number(order.get("p"), 8),
        "avg_price": avg_price,
        "quantity": qty,
        "last_filled_qty": number(order.get("l"), 8),
        "accumulated_filled_qty": number(order.get("z"), 8),
        "notional_usd": notional,
        "source": "binance_forceOrder_arr",
    }


def collect_liquidations(seconds: int) -> dict[str, Any]:
    ensure_out()
    rows: list[dict[str, Any]] = []
    started = now_utc()
    if seconds <= 0:
        return {
            "status": "skipped",
            "seconds": seconds,
            "events": 0,
            "notional_usd": 0.0,
            "started_at": iso(started),
            "finished_at": iso(now_utc()),
        }
    ws = MinimalWebSocket(FORCE_ORDER_HOST, FORCE_ORDER_PATH, timeout=5.0)
    try:
        ws.connect()
        deadline = time.time() + seconds
        while time.time() < deadline:
            try:
                text = ws.read_text()
            except socket.timeout:
                continue
            if text is None:
                break
            if not text:
                continue
            payload = json.loads(text)
            row = liquidation_row(payload, now_utc())
            if row:
                rows.append(row)
                append_csv(OUT_DIR / "hfcd_trading_v2_13_liquidation_tape.csv", row)
    except Exception as exc:  # noqa: BLE001
        return {
            "status": "failed",
            "seconds": seconds,
            "events": len(rows),
            "notional_usd": number(sum(float(r["notional_usd"]) for r in rows), 4),
            "error": str(exc),
            "started_at": iso(started),
            "finished_at": iso(now_utc()),
        }
    finally:
        ws.close()
    return {
        "status": "ok",
        "seconds": seconds,
        "events": len(rows),
        "notional_usd": number(sum(float(r["notional_usd"]) for r in rows), 4),
        "started_at": iso(started),
        "finished_at": iso(now_utc()),
    }


def read_csv_or_empty(path: Path) -> pd.DataFrame:
    if not path.exists() or path.stat().st_size == 0:
        return pd.DataFrame()
    return pd.read_csv(path)


def summarize_health(ts: datetime, liquidation_status: dict[str, Any]) -> dict[str, Any]:
    events = read_csv_or_empty(V12_DIR / "hfcd_trading_v2_12_forward_events.csv")
    snapshots = read_csv_or_empty(V12_DIR / "hfcd_trading_v2_12_forward_snapshots.csv")
    state_path = V12_DIR / "hfcd_trading_v2_12_forward_state.json"
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}

    if not events.empty:
        events["timestamp"] = pd.to_datetime(events["timestamp"], utc=True)
        today_events = events[events["timestamp"].dt.strftime("%Y-%m-%d") == ts.strftime("%Y-%m-%d")]
    else:
        today_events = events
    if not snapshots.empty:
        snapshots["timestamp"] = pd.to_datetime(snapshots["timestamp"], utc=True)
        today_snapshots = snapshots[snapshots["timestamp"].dt.strftime("%Y-%m-%d") == ts.strftime("%Y-%m-%d")]
    else:
        today_snapshots = snapshots

    open_positions = state.get("open_positions", {}) if isinstance(state, dict) else {}
    latest_reasons = []
    if not today_events.empty and "reason" in today_events.columns:
        latest_reasons = today_events.tail(10)["reason"].astype(str).tolist()
    quote_ok_rate = 0.0
    if not today_snapshots.empty and "metrics_status" in today_snapshots.columns:
        quote_ok_rate = float((today_snapshots["metrics_status"].astype(str) == "ok").mean())

    row = {
        "timestamp": iso(ts),
        "date": ts.strftime("%Y-%m-%d"),
        "v12_event_count_today": int(len(today_events)),
        "v12_snapshot_count_today": int(len(today_snapshots)),
        "paper_open_count_today": int((today_events.get("event", pd.Series(dtype=str)) == "open").sum()) if not today_events.empty else 0,
        "paper_close_count_today": int((today_events.get("event", pd.Series(dtype=str)) == "close").sum()) if not today_events.empty else 0,
        "paper_skip_count_today": int((today_events.get("event", pd.Series(dtype=str)) == "skip").sum()) if not today_events.empty else 0,
        "open_position_count": len(open_positions),
        "realized_pnl_usd": number(state.get("realized_pnl_usd", 0.0)) if isinstance(state, dict) else 0.0,
        "quote_ok_rate_today": number(quote_ok_rate, 4),
        "liquidation_status": liquidation_status.get("status"),
        "liquidation_events_this_cycle": liquidation_status.get("events", 0),
        "liquidation_notional_this_cycle": liquidation_status.get("notional_usd", 0.0),
        "latest_reasons": "|".join(latest_reasons[-5:]) if latest_reasons else "-",
        "no_real_orders": True,
        "no_online_page_change": True,
    }
    append_csv(OUT_DIR / "hfcd_trading_v2_13_cycle_audit.csv", row)
    return row


def write_daily_health() -> None:
    audit = read_csv_or_empty(OUT_DIR / "hfcd_trading_v2_13_cycle_audit.csv")
    liq = read_csv_or_empty(OUT_DIR / "hfcd_trading_v2_13_liquidation_tape.csv")
    rows: list[dict[str, Any]] = []
    dates = set()
    if not audit.empty:
        dates.update(audit["date"].astype(str).tolist())
    if not liq.empty:
        liq["event_time"] = pd.to_datetime(liq["event_time"], utc=True)
        liq["date"] = liq["event_time"].dt.strftime("%Y-%m-%d")
        dates.update(liq["date"].astype(str).tolist())
    for date in sorted(dates):
        a = audit[audit["date"].astype(str) == date] if not audit.empty else pd.DataFrame()
        l = liq[liq["date"].astype(str) == date] if not liq.empty else pd.DataFrame()
        rows.append({
            "date": date,
            "cycles": int(len(a)),
            "latest_realized_pnl_usd": number(a["realized_pnl_usd"].iloc[-1]) if not a.empty else 0.0,
            "latest_open_position_count": int(a["open_position_count"].iloc[-1]) if not a.empty else 0,
            "paper_open_count": int(a["paper_open_count_today"].max()) if not a.empty else 0,
            "paper_close_count": int(a["paper_close_count_today"].max()) if not a.empty else 0,
            "paper_skip_count": int(a["paper_skip_count_today"].max()) if not a.empty else 0,
            "avg_quote_ok_rate": number(a["quote_ok_rate_today"].mean(), 4) if not a.empty else 0.0,
            "liquidation_events": int(len(l)),
            "liquidation_notional_usd": number(l["notional_usd"].sum(), 4) if not l.empty else 0.0,
        })
    write_csv(OUT_DIR / "hfcd_trading_v2_13_daily_health.csv", rows)


def render_report(summary: dict[str, Any]) -> str:
    latest = summary.get("latest_cycle", {})
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        "- V2.13 是本地 forward daemon 外壳，不改线上页面，不下真实订单。",
        "- 每个周期先运行 V2.12 BTC/ETH paper shadow，再采集 Binance 强平流，并生成健康审计。",
        f"- 最新周期状态：`{summary.get('status')}`。",
        "",
        "## 最新健康状态",
        "",
        f"- 今日 snapshots：`{latest.get('v12_snapshot_count_today', 0)}`。",
        f"- 今日 events：`{latest.get('v12_event_count_today', 0)}`。",
        f"- 当前持仓数：`{latest.get('open_position_count', 0)}`。",
        f"- 已实现 PnL：`${latest.get('realized_pnl_usd', 0)}`。",
        f"- 本周期强平事件：`{latest.get('liquidation_events_this_cycle', 0)}`，名义金额 `${latest.get('liquidation_notional_this_cycle', 0)}`。",
        "",
        "## 文件",
        "",
    ]
    for name, path in summary.get("files", {}).items():
        lines.append(f"- `{name}`: `{path}`")
    lines.extend([
        "",
        "## 下一步",
        "",
        "如果要持续跑，用 `--cycles 0 --interval-minutes 15 --liquidation-seconds 60` 启动；如果要系统级定时，下一步再加 LaunchAgent 或 cron。",
    ])
    return "\n".join(lines) + "\n"


def run_cycle(v12: Any, args: argparse.Namespace, cycle_index: int) -> dict[str, Any]:
    ts = now_utc()
    v12_status = "skipped"
    if not args.skip_paper:
        v12.main()
        v12_status = "completed"
    liquidation_status = {"status": "skipped", "events": 0, "notional_usd": 0.0}
    if not args.skip_liquidations:
        liquidation_status = collect_liquidations(args.liquidation_seconds)
    health = summarize_health(ts, liquidation_status)
    return {
        "cycle_index": cycle_index,
        "timestamp": iso(ts),
        "v12_status": v12_status,
        "liquidation_status": liquidation_status,
        "health": health,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=VERSION)
    parser.add_argument("--cycles", type=int, default=1, help="number of cycles; 0 means run forever")
    parser.add_argument("--interval-minutes", type=float, default=15.0, help="sleep interval between cycles")
    parser.add_argument("--liquidation-seconds", type=int, default=8, help="seconds to listen to Binance forceOrder stream per cycle")
    parser.add_argument("--no-sleep", action="store_true", help="do not sleep between cycles")
    parser.add_argument("--skip-paper", action="store_true", help="skip V2.12 paper shadow cycle")
    parser.add_argument("--skip-liquidations", action="store_true", help="skip liquidation tape collection")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    ensure_out()
    v12 = load_v12()
    cycles: list[dict[str, Any]] = []
    cycle_index = 0
    while args.cycles == 0 or cycle_index < args.cycles:
        cycle_index += 1
        cycle = run_cycle(v12, args, cycle_index)
        cycles.append(cycle)
        write_daily_health()
        summary = {
            "version": VERSION,
            "updated_at": iso(now_utc()),
            "status": "forward_daemon_cycle_completed",
            "run_mode": "infinite" if args.cycles == 0 else "bounded",
            "cycles_requested": args.cycles,
            "cycles_completed_this_run": len(cycles),
            "latest_cycle": cycle["health"],
            "latest_liquidation_status": cycle["liquidation_status"],
            "no_real_orders": True,
            "no_online_page_change": True,
            "files": {
                "cycle_audit": str(OUT_DIR / "hfcd_trading_v2_13_cycle_audit.csv"),
                "daily_health": str(OUT_DIR / "hfcd_trading_v2_13_daily_health.csv"),
                "liquidation_tape": str(OUT_DIR / "hfcd_trading_v2_13_liquidation_tape.csv"),
                "summary": str(OUT_DIR / "hfcd_trading_v2_13_summary.json"),
                "report": str(OUT_DIR / "HFCD_Trading_V2_13_CryptoForwardDaemonLiquidationTape.md"),
            },
            "cycles": cycles,
        }
        (OUT_DIR / "hfcd_trading_v2_13_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        (OUT_DIR / "HFCD_Trading_V2_13_CryptoForwardDaemonLiquidationTape.md").write_text(render_report(summary), encoding="utf-8")
        if args.cycles != 0 and cycle_index >= args.cycles:
            break
        if not args.no_sleep:
            time.sleep(max(0.0, args.interval_minutes * 60))

    print(json.dumps({
        "version": VERSION,
        "status": "forward_daemon_cycle_completed",
        "cycles_completed_this_run": len(cycles),
        "latest_cycle": cycles[-1]["health"] if cycles else {},
        "output_dir": str(OUT_DIR),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
