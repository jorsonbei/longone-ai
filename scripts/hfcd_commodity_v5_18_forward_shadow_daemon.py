#!/usr/bin/env python3
"""Run V5.18 commodity exact-lineage forward shadow on a fixed interval.

This daemon intentionally does not create a new strategy. It repeatedly calls
the frozen V5.18 runner so CL=F 3h and HO=F 2h keep accumulating a forward
paper ledger while preserving the original lineage rules.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "scripts" / "hfcd_commodity_v5_18_exact_lineage_forward_shadow.py"
OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v5_18_exact_lineage_forward_shadow"
OUT_DIR.mkdir(parents=True, exist_ok=True)
RUN_LOG = OUT_DIR / "hfcd_commodity_v5_18_daemon_runs.jsonl"
STATUS_PATH = OUT_DIR / "hfcd_commodity_v5_18_daemon_status.json"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def append_jsonl(path: Path, row: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def run_once() -> dict[str, Any]:
    started = time.time()
    proc = subprocess.run(
        [sys.executable, str(RUNNER)],
        cwd=str(ROOT),
        text=True,
        capture_output=True,
        check=False,
    )
    row: dict[str, Any] = {
        "ts": utc_now(),
        "returncode": proc.returncode,
        "runtime_sec": round(time.time() - started, 3),
        "stdout_tail": proc.stdout[-4000:],
        "stderr_tail": proc.stderr[-4000:],
    }
    try:
        summary = json.loads(proc.stdout) if proc.stdout.strip() else None
    except Exception:
        summary = None
    if summary:
        row.update(
            {
                "summary_status": summary.get("status"),
                "events_this_run": summary.get("events_this_run"),
                "open_positions": summary.get("open_positions"),
                "realized_pnl_usd": summary.get("realized_pnl_usd"),
                "unrealized_pnl_usd": summary.get("unrealized_pnl_usd"),
                "equity_usd": summary.get("equity_usd"),
            }
        )
    append_jsonl(RUN_LOG, row)
    STATUS_PATH.write_text(json.dumps(row, ensure_ascii=False, indent=2), encoding="utf-8")
    return row


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--interval-sec", type=int, default=300)
    parser.add_argument("--cycles", type=int, default=0, help="0 means run forever")
    parser.add_argument("--no-sleep", action="store_true")
    args = parser.parse_args()

    cycle = 0
    while True:
        cycle += 1
        row = run_once()
        print(json.dumps({"cycle": cycle, **{k: row.get(k) for k in ["returncode", "runtime_sec", "events_this_run", "open_positions", "unrealized_pnl_usd"]}}, ensure_ascii=False))
        if args.cycles and cycle >= args.cycles:
            break
        if args.no_sleep:
            break
        time.sleep(max(15, args.interval_sec))


if __name__ == "__main__":
    main()
