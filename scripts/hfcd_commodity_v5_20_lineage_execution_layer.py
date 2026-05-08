#!/usr/bin/env python3
"""HFCD Commodity V5.20 lineage-preserved realtime execution layer.

V5.20 intentionally does not promote the dense V5.19 controller. It preserves
the two strong V5.18 lineages:

- CL=F inherits V5.4 CL 3h.
- HO=F inherits V5.9 HO 2h.

The 1m/5m scan is only allowed to participate when the latest V5.18 exact
lineage window is active. Outside that window it records skip reasons, current
paper PnL, and position state, but it does not create a new主信号.
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
V518_SCRIPT = ROOT / "scripts" / "hfcd_commodity_v5_18_exact_lineage_forward_shadow.py"
V518_DIR = ROOT / "outputs" / "hfcd_commodity_v5_18_exact_lineage_forward_shadow"
V518_SUMMARY = V518_DIR / "hfcd_commodity_v5_18_summary.json"
V518_STATE = V518_DIR / "hfcd_commodity_v5_18_paper_state.json"

OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v5_20_lineage_execution_layer"
OUT_DIR.mkdir(parents=True, exist_ok=True)

VERSION = "HFCD_Commodity_V5_20_LineageExecutionLayer"
SUMMARY_PATH = OUT_DIR / "hfcd_commodity_v5_20_summary.json"
ACTIONS_PATH = OUT_DIR / "hfcd_commodity_v5_20_execution_actions.csv"
SKIPS_PATH = OUT_DIR / "hfcd_commodity_v5_20_skip_reasons.csv"
PNL_PATH = OUT_DIR / "hfcd_commodity_v5_20_paper_pnl.csv"
REPORT_PATH = OUT_DIR / "HFCD_Commodity_V5_20_LineageExecutionLayer.md"
FIGURE_PATH = OUT_DIR / "HFCD_Commodity_V5_20_LineageExecutionLayer.png"


@dataclass(frozen=True)
class ExecutionProfile:
    symbol: str
    max_units: int
    min_micro_score: float
    add_score_multiplier: float
    reverse_score_multiplier: float
    trigger_fresh_minutes: int
    reduce_loss_pct: float


PROFILES = {
    "CL=F": ExecutionProfile(
        symbol="CL=F",
        max_units=2,
        min_micro_score=0.62,
        add_score_multiplier=1.35,
        reverse_score_multiplier=1.65,
        trigger_fresh_minutes=20,
        reduce_loss_pct=-0.010,
    ),
    "HO=F": ExecutionProfile(
        symbol="HO=F",
        max_units=1,
        min_micro_score=0.58,
        add_score_multiplier=1.28,
        reverse_score_multiplier=1.55,
        trigger_fresh_minutes=20,
        reduce_loss_pct=-0.009,
    ),
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def run_v518_once() -> dict[str, Any]:
    result = subprocess.run(
        [sys.executable, str(V518_SCRIPT)],
        cwd=str(ROOT),
        text=True,
        capture_output=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        return {
            "ok": False,
            "returncode": result.returncode,
            "stdout_tail": result.stdout[-1200:],
            "stderr_tail": result.stderr[-1200:],
        }
    return {"ok": True, "returncode": 0, "stdout_tail": result.stdout[-1200:], "stderr_tail": result.stderr[-1200:]}


def fetch_yahoo(symbol: str) -> tuple[pd.DataFrame, str, bool, int]:
    for interval, range_, base_minutes in [("1m", "7d", 1), ("5m", "10d", 5)]:
        params = urllib.parse.urlencode({"range": range_, "interval": interval, "includePrePost": "true"})
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?{params}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "HFCD-ThingNature-OS/1.0", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=18) as res:
                payload = json.loads(res.read().decode("utf-8"))
            result = payload["chart"]["result"][0]
            ts = result.get("timestamp", [])
            quote = result.get("indicators", {}).get("quote", [{}])[0]
            rows = []
            for i, stamp in enumerate(ts):
                close = quote.get("close", [None] * len(ts))[i]
                if close is None or not math.isfinite(float(close)) or float(close) <= 0:
                    continue
                rows.append(
                    {
                        "timestamp": datetime.fromtimestamp(int(stamp), tz=timezone.utc),
                        "close": float(close),
                        "volume": float(quote.get("volume", [0] * len(ts))[i] or 0),
                    }
                )
            frame = pd.DataFrame(rows).dropna(subset=["close"]).sort_values("timestamp").reset_index(drop=True)
            if len(frame) >= 120:
                return frame, f"yahoo_chart:{symbol}:{interval}/{range_}", True, base_minutes
        except Exception:
            continue
    return fallback_frame(symbol)


def fallback_frame(symbol: str) -> tuple[pd.DataFrame, str, bool, int]:
    now = utc_now()
    base = 95.0 if symbol == "CL=F" else 3.85
    rows = []
    for i in range(720):
        t = now - pd.Timedelta(minutes=5 * (719 - i))
        wave = math.sin(i / 17 + len(symbol)) * 0.006 + math.sin(i / 88) * 0.012
        rows.append({"timestamp": t, "close": base * (1 + wave), "volume": 1000 + abs(math.sin(i / 14)) * 700})
    return pd.DataFrame(rows), f"fallback_simulated:{symbol}:5m", False, 5


def return_over(frame: pd.DataFrame, minutes: int, base_minutes: int) -> float:
    bars = max(1, int(round(minutes / max(base_minutes, 1))))
    if len(frame) <= bars:
        return 0.0
    return float(frame["close"].iloc[-1] / frame["close"].iloc[-1 - bars] - 1.0)


def micro_signal(symbol: str) -> dict[str, Any]:
    frame, source, real, base_minutes = fetch_yahoo(symbol)
    returns = frame["close"].pct_change().dropna()
    vol_1h = max(float(returns.tail(max(12, int(60 / base_minutes))).std() or 0.0001), 0.0001)
    ret_15m = return_over(frame, 15, base_minutes)
    ret_30m = return_over(frame, 30, base_minutes)
    ret_1h = return_over(frame, 60, base_minutes)
    ret_2h = return_over(frame, 120, base_minutes)
    ret_3h = return_over(frame, 180, base_minutes)
    recent_volume = float(frame["volume"].tail(max(5, int(30 / base_minutes))).sum())
    base_volume = float(frame["volume"].tail(max(30, int(360 / base_minutes))).mean() * max(1, int(30 / base_minutes)))
    volume_shock = max(-1.0, min(1.0, recent_volume / max(base_volume, 1.0) - 1.0))
    signed = 0.38 * ret_15m + 0.27 * ret_30m + 0.22 * ret_1h + 0.08 * ret_2h + 0.05 * ret_3h
    signed += 0.10 * volume_shock * vol_1h
    score = min(2.5, abs(signed) / vol_1h)
    side = "long" if signed > 0 else "short" if signed < 0 else "flat"
    return {
        "symbol": symbol,
        "source": source,
        "is_real_market_data": real,
        "base_interval_minutes": base_minutes,
        "timestamp": frame["timestamp"].iloc[-1].isoformat(),
        "price": float(frame["close"].iloc[-1]),
        "micro_side": side,
        "micro_score": round(float(score), 4),
        "ret_15m": round(ret_15m, 6),
        "ret_30m": round(ret_30m, 6),
        "ret_1h": round(ret_1h, 6),
        "ret_2h": round(ret_2h, 6),
        "ret_3h": round(ret_3h, 6),
        "volume_shock": round(volume_shock, 4),
    }


def position_unrealized(pos: dict[str, Any], price: float) -> float:
    side = str(pos.get("side", "long"))
    qty = float(pos.get("quantity", 0.0))
    entry = float(pos.get("entry_price", price))
    gross = (price - entry) * qty if side == "long" else (entry - price) * qty
    return gross - float(pos.get("open_fee_usd", 0.0))


def signal_is_active(signal: dict[str, Any], profile: ExecutionProfile, now: datetime) -> tuple[bool, str]:
    if not signal:
        return False, "missing_v5_18_signal"
    if signal.get("action") == "NO_TRADE":
        return False, "v5_18_signal_no_trade"
    if float(signal.get("score", 0.0)) < float(signal.get("min_score", 0.0)):
        return False, "v5_18_score_underthreshold"
    try:
        stamp = datetime.fromisoformat(str(signal.get("timestamp")).replace("Z", "+00:00"))
        age_minutes = (now - stamp).total_seconds() / 60.0
    except Exception:
        return False, "invalid_v5_18_signal_timestamp"
    if age_minutes > profile.trigger_fresh_minutes:
        return False, "outside_v5_18_trigger_window"
    return True, "v5_18_trigger_window_active"


def decide_action(
    signal: dict[str, Any],
    micro: dict[str, Any],
    positions: list[dict[str, Any]],
    profile: ExecutionProfile,
    now: datetime,
) -> dict[str, Any]:
    active, window_reason = signal_is_active(signal, profile, now)
    signal_side = str(signal.get("side", "flat"))
    micro_side = str(micro.get("micro_side", "flat"))
    micro_score = float(micro.get("micro_score", 0.0))
    price = float(micro.get("price", signal.get("price", 0.0)))
    symbol_positions = [p for p in positions if p.get("symbol") == profile.symbol]
    current_side = str(symbol_positions[0].get("side")) if symbol_positions else "flat"
    current_units = len(symbol_positions)
    unrealized = sum(position_unrealized(p, price) for p in symbol_positions)
    trade_value = sum(float(p.get("trade_value_usd", 0.0)) for p in symbol_positions)
    pnl_pct = unrealized / max(trade_value, 1.0)
    controller = "SKIP"
    reason = window_reason

    if not active:
        controller = "HOLD" if symbol_positions else "SKIP"
        return {
            "controller_action": controller,
            "reason": reason,
            "target_side": current_side,
            "current_side": current_side,
            "current_units": current_units,
            "pnl_pct": round(pnl_pct, 6),
            "unrealized_pnl_usd": round(unrealized, 2),
        }

    if micro_side != signal_side or micro_score < profile.min_micro_score:
        controller = "HOLD" if symbol_positions else "SKIP"
        reason = "micro_layer_not_confirmed"
    elif not symbol_positions:
        controller = "OPEN_SHADOW"
        reason = "v5_18_window_and_micro_confirm_open"
    elif current_side == signal_side:
        if current_units < profile.max_units and float(signal.get("score", 0.0)) >= float(signal.get("min_score", 0.1)) * profile.add_score_multiplier and micro_score >= profile.min_micro_score + 0.20:
            controller = "ADD_SHADOW"
            reason = "same_side_lineage_and_micro_strengthened"
        elif pnl_pct <= profile.reduce_loss_pct and micro_score < profile.min_micro_score + 0.10:
            controller = "REDUCE_SHADOW"
            reason = "same_side_position_losing_and_micro_weak"
        else:
            controller = "HOLD"
            reason = "same_side_lineage_hold"
    elif current_side != "flat" and current_side != signal_side:
        if float(signal.get("score", 0.0)) >= float(signal.get("min_score", 0.1)) * profile.reverse_score_multiplier and micro_score >= profile.min_micro_score + 0.15:
            controller = "REVERSE_SHADOW"
            reason = "opposite_v5_18_window_and_micro_confirmed"
        else:
            controller = "REDUCE_SHADOW"
            reason = "opposite_signal_but_reverse_not_strong_enough"

    return {
        "controller_action": controller,
        "reason": reason,
        "target_side": signal_side if controller not in {"HOLD", "SKIP"} else current_side,
        "current_side": current_side,
        "current_units": current_units,
        "pnl_pct": round(pnl_pct, 6),
        "unrealized_pnl_usd": round(unrealized, 2),
    }


def append_csv(path: Path, rows: list[dict[str, Any]], dedupe_subset: list[str] | None = None) -> pd.DataFrame:
    if not rows:
        return pd.read_csv(path) if path.exists() else pd.DataFrame()
    df = pd.DataFrame(rows)
    if path.exists():
        old = pd.read_csv(path)
        df = pd.concat([old, df], ignore_index=True)
    if dedupe_subset:
        df = df.drop_duplicates(subset=dedupe_subset, keep="last")
    df.to_csv(path, index=False)
    return df


def write_report(summary: dict[str, Any], actions: list[dict[str, Any]]) -> None:
    lines = [
        f"# {VERSION}",
        "",
        "## 定位",
        "V5.20 保留 V5.18 强血统，不晋升 V5.19 过密交易版本。1m/5m 只在 V5.18 原始触发窗口附近参与加仓、减仓、反手审计。",
        "",
        "## 本轮执行层",
        "| 标的 | V5.18信号 | 微观方向 | 动作 | 原因 | 未实现PnL |",
        "|---|---:|---:|---:|---|---:|",
    ]
    for row in actions:
        lines.append(
            f"| {row['symbol']} | {row['v5_18_action']} | {row['micro_side']} {row['micro_score']:.2f} | "
            f"{row['controller_action']} | {row['reason']} | ${row['unrealized_pnl_usd']:.2f} |"
        )
    lines.extend(
        [
            "",
            "## Paper PnL",
            f"- open_positions: {summary['paper_pnl']['open_positions']}",
            f"- realized_pnl_usd: {summary['paper_pnl']['realized_pnl_usd']}",
            f"- unrealized_pnl_usd: {summary['paper_pnl']['unrealized_pnl_usd']}",
            f"- settled_equity_usd: {summary['paper_pnl']['settled_equity_usd']}",
            f"- equity_usd: {summary['paper_pnl']['equity_usd']}",
            "",
            "## Gate",
            "只有在 V5.18 强血统窗口 active 且微观层同向确认时，V5.20 才允许 OPEN/ADD/REDUCE/REVERSE 的 shadow 建议。否则只记录跳过原因。",
        ]
    )
    REPORT_PATH.write_text("\n".join(lines), encoding="utf-8")


def write_figure(actions_df: pd.DataFrame) -> None:
    if actions_df.empty:
        return
    latest = actions_df.tail(20)
    fig, axes = plt.subplots(1, 2, figsize=(10, 4))
    counts = latest["controller_action"].value_counts()
    axes[0].bar(counts.index, counts.values, color="#38bdf8")
    axes[0].set_title("V5.20 action audit")
    axes[0].tick_params(axis="x", labelrotation=30)
    for symbol, group in latest.groupby("symbol"):
        axes[1].plot(range(len(group)), group["unrealized_pnl_usd"].astype(float), marker="o", label=symbol)
    axes[1].set_title("Open-position unrealized PnL")
    axes[1].legend(loc="best")
    for ax in axes:
        ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(FIGURE_PATH, dpi=160)
    plt.close(fig)


def main() -> None:
    started = time.time()
    v518_run = run_v518_once()
    now = utc_now()
    v518_summary = read_json(V518_SUMMARY, {})
    v518_state = read_json(V518_STATE, {})
    positions = list(v518_state.get("positions") or [])
    signals = {str(s.get("symbol")): s for s in v518_summary.get("signals", [])}

    action_rows: list[dict[str, Any]] = []
    skip_rows: list[dict[str, Any]] = []
    for symbol, profile in PROFILES.items():
        signal = signals.get(symbol, {})
        micro = micro_signal(symbol)
        decision = decide_action(signal, micro, positions, profile, now)
        row = {
            "generated_at": now.isoformat(),
            "symbol": symbol,
            "v5_18_signal_id": signal.get("signal_id", ""),
            "v5_18_action": signal.get("action", "MISSING"),
            "v5_18_side": signal.get("side", "flat"),
            "v5_18_score": float(signal.get("score", 0.0) or 0.0),
            "v5_18_min_score": float(signal.get("min_score", 0.0) or 0.0),
            "v5_18_price": float(signal.get("price", 0.0) or 0.0),
            "micro_side": micro["micro_side"],
            "micro_score": float(micro["micro_score"]),
            "micro_price": float(micro["price"]),
            "micro_source": micro["source"],
            "is_real_market_data": bool(micro["is_real_market_data"]) and bool(signal.get("is_real_market_data", False)),
            **decision,
            "ret_15m": micro["ret_15m"],
            "ret_30m": micro["ret_30m"],
            "ret_1h": micro["ret_1h"],
            "ret_2h": micro["ret_2h"],
            "ret_3h": micro["ret_3h"],
            "volume_shock": micro["volume_shock"],
        }
        action_rows.append(row)
        if row["controller_action"] in {"SKIP", "HOLD"}:
            skip_rows.append(
                {
                    "generated_at": row["generated_at"],
                    "symbol": symbol,
                    "controller_action": row["controller_action"],
                    "reason": row["reason"],
                    "v5_18_action": row["v5_18_action"],
                    "micro_side": row["micro_side"],
                    "micro_score": row["micro_score"],
                }
            )

    actions_df = append_csv(ACTIONS_PATH, action_rows, dedupe_subset=["generated_at", "symbol"])
    append_csv(SKIPS_PATH, skip_rows)
    paper_pnl = {
        "generated_at": now.isoformat(),
        "open_positions": len(positions),
        "realized_pnl_usd": round(float(v518_summary.get("realized_pnl_usd", v518_state.get("realized_pnl_usd", 0.0)) or 0.0), 2),
        "unrealized_pnl_usd": round(float(v518_summary.get("unrealized_pnl_usd", 0.0) or 0.0), 2),
        "settled_equity_usd": round(float(v518_summary.get("settled_equity_usd", v518_state.get("settled_equity_usd", 0.0)) or 0.0), 2),
        "equity_usd": round(float(v518_summary.get("equity_usd", v518_state.get("equity_usd", 0.0)) or 0.0), 2),
    }
    append_csv(PNL_PATH, [paper_pnl], dedupe_subset=["generated_at"])

    summary = {
        "version": VERSION,
        "generated_at": now.isoformat(),
        "status": "lineage_execution_shadow_running",
        "decision": "keep_v5_18_main_lineage",
        "v5_18_run": v518_run,
        "v5_18_summary_generated_at": v518_summary.get("generated_at"),
        "routes": {
            "CL=F": "V5.4 CL 3h exact lineage",
            "HO=F": "V5.9 HO 2h exact lineage",
        },
        "actions_this_run": action_rows,
        "action_counts": pd.Series([r["controller_action"] for r in action_rows]).value_counts().to_dict() if action_rows else {},
        "skip_reasons_this_run": skip_rows,
        "paper_pnl": paper_pnl,
        "real_market_symbols": sum(1 for row in action_rows if row["is_real_market_data"]),
        "runtime_sec": round(time.time() - started, 3),
        "outputs": {
            "summary_json": str(SUMMARY_PATH),
            "actions_csv": str(ACTIONS_PATH),
            "skip_reasons_csv": str(SKIPS_PATH),
            "paper_pnl_csv": str(PNL_PATH),
            "report_md": str(REPORT_PATH),
            "figure_png": str(FIGURE_PATH),
        },
    }
    SUMMARY_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    write_report(summary, action_rows)
    write_figure(actions_df)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
