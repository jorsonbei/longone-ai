#!/usr/bin/env python3
"""Health check for HFCD V2.23 crypto testnet mirror outputs."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v2_23_crypto_frequency_router_testnet_mirror"
SUMMARY_PATH = OUT_DIR / "hfcd_trading_v2_23_summary.json"
SAFETY_PATH = OUT_DIR / "hfcd_trading_v2_23_safety_report.json"
MAX_STALE_MINUTES = 35


def parse_ts(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    now = datetime.now(timezone.utc)
    summary = read_json(SUMMARY_PATH)
    safety = read_json(SAFETY_PATH)
    alerts: list[str] = []

    if not summary:
        alerts.append("summary_missing")
    if not safety:
        alerts.append("safety_report_missing")

    finished_at = parse_ts(str(summary.get("finished_at", "")))
    age_minutes = None
    if finished_at:
        age_minutes = round((now - finished_at).total_seconds() / 60.0, 2)
        if age_minutes > MAX_STALE_MINUTES:
            alerts.append("summary_stale")
    elif summary:
        alerts.append("summary_finished_at_missing")

    if summary.get("status") not in {None, "testnet_mirror_cycle_completed"}:
        alerts.append(f"summary_status_{summary.get('status')}")
    if summary.get("testnet_credentials_status") not in {None, "ready"}:
        alerts.append("testnet_credentials_not_ready")
    if int(summary.get("orders_blocked_this_cycle") or 0) > 0:
        alerts.append("orders_blocked_this_cycle")

    if safety.get("status") not in {None, "clean"}:
        alerts.append(f"safety_status_{safety.get('status')}")
    if safety.get("risk_flags"):
        alerts.append("safety_risk_flags_present")
    if safety.get("positions"):
        alerts.append("testnet_positions_present")
    if safety.get("open_orders"):
        alerts.append("testnet_open_orders_present")

    payload = {
        "version": "HFCD_Trading_V2_23_CryptoHealthCheck",
        "checked_at": now.isoformat().replace("+00:00", "Z"),
        "status": "alert" if alerts else "healthy",
        "alerts": alerts,
        "summary_age_minutes": age_minutes,
        "summary_status": summary.get("status", ""),
        "safety_status": safety.get("status", ""),
        "risk_flags": safety.get("risk_flags", []),
        "positions_count": len(safety.get("positions", []) or []),
        "open_orders_count": len(safety.get("open_orders", []) or []),
        "orders_sent_this_cycle": summary.get("orders_sent_this_cycle", ""),
        "orders_blocked_this_cycle": summary.get("orders_blocked_this_cycle", ""),
        "summary_path": str(SUMMARY_PATH),
        "safety_path": str(SAFETY_PATH),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    raise SystemExit(1 if alerts else 0)


if __name__ == "__main__":
    main()
