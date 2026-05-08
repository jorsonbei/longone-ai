#!/usr/bin/env python3
"""HFCD Commodity V5.19 realtime multi-horizon position controller.

V5.19 is not promoted to live execution. It is a controller layer that reads the
current market every run, predicts multiple future horizons from the current
state, and emits open/add/reduce/reverse/hold suggestions. V5.18 remains the
exact-lineage forward paper ledger; this script is the next research layer.
"""

from __future__ import annotations

import json
import math
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v5_19_realtime_multihorizon_position_controller"
OUT_DIR.mkdir(parents=True, exist_ok=True)

V518_STATE = ROOT / "outputs" / "hfcd_commodity_v5_18_exact_lineage_forward_shadow" / "hfcd_commodity_v5_18_paper_state.json"
VERSION = "HFCD_Commodity_V5_19_RealtimeMultiHorizonPositionController"

SUMMARY_PATH = OUT_DIR / "hfcd_commodity_v5_19_summary.json"
PREDICTIONS_PATH = OUT_DIR / "hfcd_commodity_v5_19_predictions.csv"
CONTROLLER_PATH = OUT_DIR / "hfcd_commodity_v5_19_controller_actions.csv"
BLIND_PATH = OUT_DIR / "hfcd_commodity_v5_19_blind_backtest.csv"
BLIND_SUMMARY_PATH = OUT_DIR / "hfcd_commodity_v5_19_blind_summary.csv"
REPORT_PATH = OUT_DIR / "HFCD_Commodity_V5_19_RealtimeMultiHorizonPositionController.md"
FIGURE_PATH = OUT_DIR / "HFCD_Commodity_V5_19_RealtimeMultiHorizonPositionController.png"


SYMBOLS = ["CL=F", "RB=F", "HO=F", "NG=F"]
HORIZONS_MIN = [15, 30, 60, 90, 120, 150, 180]
LOOKBACK_MIN = [5, 15, 30, 60, 120, 180, 300, 480, 720, 1440]


@dataclass(frozen=True)
class SymbolProfile:
    symbol: str
    name: str
    max_units: int
    min_confidence: float
    min_expected_bps: float
    cost_bps: float


PROFILES = {
    "CL=F": SymbolProfile("CL=F", "WTI Crude Oil Futures", 2, 0.58, 13.0, 7.5),
    "RB=F": SymbolProfile("RB=F", "RBOB Gasoline Futures", 1, 0.59, 14.0, 8.5),
    "HO=F": SymbolProfile("HO=F", "Heating Oil Futures", 1, 0.57, 12.0, 8.0),
    "NG=F": SymbolProfile("NG=F", "Natural Gas Futures", 1, 0.61, 18.0, 11.0),
}

LINEAGE_BASELINES = {
    "CL=F": {"lineage": "V5.4 CL 3h strong baseline", "horizon": "3h", "hit_rate": 0.64, "profit_factor": 4.41},
    "HO=F": {"lineage": "V5.9/V5.6 HO 2h hit-rate lineage", "horizon": "2h", "hit_rate": 0.7692, "profit_factor": 1.28},
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def label_for_minutes(minutes: int) -> str:
    if minutes < 60:
        return f"{minutes}m"
    whole = minutes // 60
    rem = minutes % 60
    if rem == 0:
        return f"{whole}h"
    if rem == 30:
        return f"{whole}.5h"
    return f"{whole}h{rem}m"


def yahoo_chart(symbol: str, interval: str, range_: str) -> tuple[pd.DataFrame, str, bool]:
    params = urllib.parse.urlencode({"range": range_, "interval": interval, "includePrePost": "true"})
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?{params}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "HFCD-ThingNature-OS/1.0", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as res:
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
                    "open": float(quote.get("open", [close] * len(ts))[i] or close),
                    "high": float(quote.get("high", [close] * len(ts))[i] or close),
                    "low": float(quote.get("low", [close] * len(ts))[i] or close),
                    "close": float(close),
                    "volume": float(quote.get("volume", [0] * len(ts))[i] or 0),
                }
            )
        frame = pd.DataFrame(rows).dropna(subset=["close"]).sort_values("timestamp").reset_index(drop=True)
        if len(frame) < 120:
            raise RuntimeError(f"insufficient rows: {len(frame)}")
        return frame, f"yahoo_chart:{symbol}:{interval}/{range_}", True
    except Exception:
        now = utc_now()
        base = {"CL=F": 94.0, "RB=F": 3.0, "HO=F": 3.8, "NG=F": 3.6}.get(symbol, 50.0)
        rows = []
        for i in range(720):
            t = now - timedelta(minutes=5 * (719 - i))
            wave = math.sin(i / 18 + len(symbol)) * 0.006 + math.sin(i / 96) * 0.012
            rows.append({"timestamp": t, "open": base * (1 + wave * 0.98), "high": base * (1 + wave + 0.002), "low": base * (1 + wave - 0.002), "close": base * (1 + wave), "volume": 1000 + abs(math.sin(i / 15)) * 800})
        return pd.DataFrame(rows), f"fallback_simulated:{symbol}:5m", False


def load_series(symbol: str) -> tuple[pd.DataFrame, str, bool, int]:
    try:
        frame, source, real = yahoo_chart(symbol, "1m", "7d")
        return frame, source, real, 1
    except Exception:
        frame, source, real = yahoo_chart(symbol, "5m", "10d")
        return frame, source, real, 5


def load_v518_positions() -> list[dict[str, Any]]:
    if not V518_STATE.exists():
        return []
    try:
        state = json.loads(V518_STATE.read_text(encoding="utf-8"))
    except Exception:
        return []
    return list(state.get("positions") or [])


def return_over(frame: pd.DataFrame, minutes: int, base_minutes: int) -> float:
    bars = max(1, int(round(minutes / max(base_minutes, 1))))
    if len(frame) <= bars:
        return 0.0
    return float(frame["close"].iloc[-1] / frame["close"].iloc[-1 - bars] - 1.0)


def momentum_stack(frame: pd.DataFrame, base_minutes: int) -> dict[str, float]:
    values: dict[str, float] = {}
    for minutes in LOOKBACK_MIN:
        values[f"ret_{label_for_minutes(minutes)}"] = return_over(frame, minutes, base_minutes)
    return values


def prediction_rows_from_frame(
    symbol: str,
    frame: pd.DataFrame,
    source: str,
    real: bool,
    base_minutes: int,
    generated_at: datetime | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    profile = PROFILES[symbol]
    generated_at = generated_at or utc_now()
    close = float(frame["close"].iloc[-1])
    returns = frame["close"].pct_change().dropna()
    vol_1h = float(returns.tail(max(12, int(60 / base_minutes))).std() or 0.0001)
    vol_day = float(returns.tail(max(48, int(1440 / base_minutes))).std() or vol_1h)
    volume_recent = float(frame["volume"].tail(max(5, int(30 / base_minutes))).sum())
    volume_base = float(frame["volume"].tail(max(30, int(360 / base_minutes))).mean() * max(1, int(30 / base_minutes)))
    volume_shock = max(-1.0, min(1.0, volume_recent / max(volume_base, 1.0) - 1.0))
    stack = momentum_stack(frame, base_minutes)
    short_stack = np.mean([stack["ret_5m"], stack["ret_15m"], stack["ret_30m"]])
    medium_stack = np.mean([stack["ret_1h"], stack["ret_2h"], stack["ret_3h"]])
    long_stack = np.mean([stack["ret_5h"], stack["ret_8h"], stack["ret_12h"], stack["ret_24h"]])
    context_alignment = float(np.sign(short_stack) == np.sign(medium_stack)) + float(np.sign(medium_stack) == np.sign(long_stack))
    quality = 0.45 * abs(short_stack) / max(vol_1h, 1e-5) + 0.35 * abs(medium_stack) / max(vol_day, 1e-5) + 0.20 * max(volume_shock, 0)
    signed_core = 0.45 * short_stack + 0.35 * medium_stack + 0.20 * long_stack + 0.12 * volume_shock * max(vol_1h, vol_day)
    rows = []
    for horizon in HORIZONS_MIN:
        horizon_label = label_for_minutes(horizon)
        scale = math.sqrt(max(horizon, 1) / 60.0)
        signed_signal = math.tanh(signed_core / max(vol_1h * scale, 1e-5))
        direction = "long" if signed_signal > 0 else "short" if signed_signal < 0 else "flat"
        confidence = 0.50 + min(0.48, abs(signed_signal) * 0.33 + quality * 0.035 + context_alignment * 0.025)
        expected_return = signed_signal * max(vol_1h, vol_day * 0.75) * scale * 1.8
        expected_bps = abs(expected_return) * 10000.0
        action = "NO_TRADE"
        if confidence >= profile.min_confidence and expected_bps >= max(profile.min_expected_bps, profile.cost_bps * 1.7):
            action = "BUY_LONG" if direction == "long" else "SELL_SHORT"
        rows.append(
            {
                "generated_at": generated_at.isoformat(),
                "symbol": symbol,
                "name": profile.name,
                "source": source,
                "is_real_market_data": real,
                "base_interval_minutes": base_minutes,
                "timestamp": frame["timestamp"].iloc[-1].isoformat(),
                "price": close,
                "horizon": horizon_label,
                "horizon_minutes": horizon,
                "direction": direction,
                "action": action,
                "confidence": round(confidence, 4),
                "expected_return": round(expected_return, 6),
                "expected_bps": round(expected_bps, 2),
                "cost_bps": profile.cost_bps,
                "quality": round(quality, 4),
                "volume_shock": round(volume_shock, 4),
                "short_stack": round(short_stack, 6),
                "medium_stack": round(medium_stack, 6),
                "long_stack": round(long_stack, 6),
                **{k: round(v, 6) for k, v in stack.items()},
            }
        )
    meta = {"symbol": symbol, "source": source, "is_real_market_data": real, "rows": len(frame), "base_interval_minutes": base_minutes, "latest_price": close}
    return rows, meta


def predict_symbol(symbol: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    frame, source, real, base_minutes = load_series(symbol)
    return prediction_rows_from_frame(symbol, frame, source, real, base_minutes)


def profit_factor(pnls: pd.Series) -> float:
    wins = float(pnls[pnls > 0].sum())
    losses = float(-pnls[pnls < 0].sum())
    if losses <= 1e-9:
        return 999.0 if wins > 0 else 0.0
    return wins / losses


def max_drawdown_usd(pnls: pd.Series) -> float:
    if pnls.empty:
        return 0.0
    equity = pnls.cumsum()
    running_max = equity.cummax().clip(lower=0)
    drawdown = equity - running_max
    return float(drawdown.min())


def blind_backtest_symbol(symbol: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    profile = PROFILES[symbol]
    frame, source, real, base_minutes = load_series(symbol)
    max_horizon_bars = max(1, int(round(max(HORIZONS_MIN) / max(base_minutes, 1))))
    warmup_bars = max(80, int(round(max(LOOKBACK_MIN) / max(base_minutes, 1))) + 5)
    step_bars = max(1, int(round(5 / max(base_minutes, 1))))
    rows: list[dict[str, Any]] = []
    if len(frame) <= warmup_bars + max_horizon_bars + 5:
        return rows, [], {"symbol": symbol, "source": source, "is_real_market_data": real, "rows": len(frame), "status": "insufficient_history"}

    for i in range(warmup_bars, len(frame) - max_horizon_bars - 1, step_bars):
        now_frame = frame.iloc[: i + 1].copy()
        generated_at = pd.to_datetime(frame["timestamp"].iloc[i]).to_pydatetime()
        try:
            predictions, _ = prediction_rows_from_frame(symbol, now_frame, source, real, base_minutes, generated_at)
        except Exception:
            continue
        for pred in predictions:
            action = str(pred["action"])
            if action == "NO_TRADE":
                continue
            horizon_minutes = int(pred["horizon_minutes"])
            horizon_bars = max(1, int(round(horizon_minutes / max(base_minutes, 1))))
            future_index = i + horizon_bars
            if future_index >= len(frame):
                continue
            entry_price = float(frame["close"].iloc[i])
            exit_price = float(frame["close"].iloc[future_index])
            raw_return = exit_price / entry_price - 1.0
            signed_return = raw_return if action == "BUY_LONG" else -raw_return
            net_return = signed_return - (profile.cost_bps / 10000.0)
            rows.append(
                {
                    "symbol": symbol,
                    "generated_at": generated_at.isoformat(),
                    "source": source,
                    "is_real_market_data": real,
                    "base_interval_minutes": base_minutes,
                    "horizon": pred["horizon"],
                    "horizon_minutes": horizon_minutes,
                    "action": action,
                    "direction": pred["direction"],
                    "confidence": pred["confidence"],
                    "expected_bps": pred["expected_bps"],
                    "entry_price": entry_price,
                    "exit_price": exit_price,
                    "raw_return": round(raw_return, 6),
                    "signed_return": round(signed_return, 6),
                    "net_return": round(net_return, 6),
                    "pnl_usd": round(net_return * 1000.0, 4),
                    "direction_hit": bool(signed_return > 0),
                }
            )

    if not rows:
        return rows, [], {"symbol": symbol, "source": source, "is_real_market_data": real, "rows": len(frame), "status": "no_trades"}

    df = pd.DataFrame(rows)
    day_span = max(1e-6, (pd.to_datetime(frame["timestamp"].iloc[-1]) - pd.to_datetime(frame["timestamp"].iloc[warmup_bars])).total_seconds() / 86400.0)
    summaries: list[dict[str, Any]] = []
    for (sym, horizon), group in df.groupby(["symbol", "horizon"], sort=False):
        pnls = group["pnl_usd"].astype(float)
        summaries.append(
            {
                "symbol": sym,
                "horizon": horizon,
                "trades": int(len(group)),
                "direction_hit_rate": float(group["direction_hit"].mean()),
                "net_pnl_usd": float(pnls.sum()),
                "profit_factor": profit_factor(pnls),
                "max_drawdown_usd": max_drawdown_usd(pnls),
                "actions_per_day": float(len(group) / day_span),
                "source": source,
                "is_real_market_data": real,
            }
        )
    meta = {"symbol": symbol, "source": source, "is_real_market_data": real, "rows": len(frame), "status": "ok", "blind_rows": len(rows)}
    return rows, summaries, meta


def run_blind_backtest() -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    all_rows: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    coverage: list[dict[str, Any]] = []
    for symbol in SYMBOLS:
        rows, symbol_summary, meta = blind_backtest_symbol(symbol)
        all_rows.extend(rows)
        summaries.extend(symbol_summary)
        coverage.append(meta)
    return all_rows, summaries, coverage


def blind_recommendation(blind_summaries: list[dict[str, Any]]) -> dict[str, Any]:
    best_by_symbol: dict[str, dict[str, Any]] = {}
    for row in blind_summaries:
        current = best_by_symbol.get(str(row["symbol"]))
        if current is None or (float(row["profit_factor"]), float(row["net_pnl_usd"])) > (float(current["profit_factor"]), float(current["net_pnl_usd"])):
            best_by_symbol[str(row["symbol"])] = row
    promotions = []
    for symbol, row in best_by_symbol.items():
        baseline = LINEAGE_BASELINES.get(symbol)
        if not baseline:
            continue
        passes_sample = int(row["trades"]) >= 25
        passes_hit = float(row["direction_hit_rate"]) >= float(baseline["hit_rate"])
        passes_pf = float(row["profit_factor"]) >= float(baseline["profit_factor"])
        if passes_sample and passes_hit and passes_pf:
            promotions.append({"symbol": symbol, "candidate": row, "baseline": baseline})
    return {
        "best_by_symbol": best_by_symbol,
        "lineage_baselines": LINEAGE_BASELINES,
        "promotion_candidates": promotions,
        "decision": "keep_v5_18_default" if not promotions else "review_promotion_candidates",
        "note": "V5.19 must beat each frozen lineage on sample size, hit rate, and PF before replacing V5.18.",
    }


def controller_actions(predictions: list[dict[str, Any]], positions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_symbol: dict[str, list[dict[str, Any]]] = {}
    for row in predictions:
        by_symbol.setdefault(str(row["symbol"]), []).append(row)
    pos_by_symbol: dict[str, list[dict[str, Any]]] = {}
    for pos in positions:
        pos_by_symbol.setdefault(str(pos.get("symbol")), []).append(pos)

    actions = []
    for symbol, rows in by_symbol.items():
        profile = PROFILES[symbol]
        tradable = [r for r in rows if r["action"] != "NO_TRADE"]
        best = max(rows, key=lambda r: (r["action"] != "NO_TRADE", r["confidence"], r["expected_bps"]))
        current = pos_by_symbol.get(symbol, [])
        current_units = len(current)
        current_side = str(current[0].get("side")) if current else "flat"
        target_side = "long" if best["action"] == "BUY_LONG" else "short" if best["action"] == "SELL_SHORT" else "flat"
        controller = "NO_TRADE"
        reason = "no horizon cleared confidence and expected move"
        if not current and target_side != "flat":
            controller = "OPEN_LONG" if target_side == "long" else "OPEN_SHORT"
            reason = f"{best['horizon']} prediction cleared confidence and cost"
        elif current and target_side == "flat":
            controller = "REDUCE" if best["confidence"] < 0.58 else "HOLD"
            reason = "existing position but current multi-horizon edge is weak"
        elif current and target_side == current_side:
            if best["confidence"] >= profile.min_confidence + 0.08 and current_units < profile.max_units:
                controller = "ADD"
                reason = "same-side multi-horizon confidence strengthened"
            elif best["confidence"] < profile.min_confidence:
                controller = "REDUCE"
                reason = "same-side confidence fell below specialist threshold"
            else:
                controller = "HOLD"
                reason = "same-side signal remains valid"
        elif current and target_side != "flat" and target_side != current_side:
            controller = "REVERSE" if best["confidence"] >= profile.min_confidence + 0.06 else "REDUCE"
            reason = "opposite multi-horizon signal confirmed" if controller == "REVERSE" else "opposite signal not strong enough for full reverse"
        actions.append(
            {
                "generated_at": utc_now().isoformat(),
                "symbol": symbol,
                "current_side": current_side,
                "current_units": current_units,
                "controller_action": controller,
                "target_side": target_side,
                "best_horizon": best["horizon"],
                "best_action": best["action"],
                "confidence": best["confidence"],
                "expected_bps": best["expected_bps"],
                "reason": reason,
                "tradable_horizons": ",".join(r["horizon"] for r in tradable),
            }
        )
    return actions


def write_report(summary: dict[str, Any], actions: list[dict[str, Any]], blind_summaries: list[dict[str, Any]]) -> None:
    lines = [
        f"# {VERSION}",
        "",
        f"- generated_at: {summary['generated_at']}",
        f"- status: {summary['status']}",
        f"- real_market_symbols: {summary['real_market_symbols']}/{summary['symbols']}",
        f"- controller_actions: {summary['controller_action_count']}",
        "",
        "## Controller Actions",
        "",
    ]
    if actions:
        lines.append("| symbol | action | side | horizon | confidence | expected_bps | reason |")
        lines.append("|---|---:|---:|---:|---:|---:|---|")
        for row in actions:
            lines.append(
                f"| {row['symbol']} | {row['controller_action']} | {row['target_side']} | {row['best_horizon']} | "
                f"{row['confidence']:.3f} | {row['expected_bps']:.1f} | {row['reason']} |"
            )
    else:
        lines.append("No controller actions were generated.")
    lines.extend(
        [
            "",
            "## Local Blind Backtest",
            "",
            "This local blind backtest is research-only. V5.18 remains the default unless V5.19 beats the frozen lineage on sample size, hit rate, and PF.",
            "",
        ]
    )
    if blind_summaries:
        best = {}
        for row in blind_summaries:
            symbol = str(row["symbol"])
            current = best.get(symbol)
            if current is None or (float(row["profit_factor"]), float(row["net_pnl_usd"])) > (float(current["profit_factor"]), float(current["net_pnl_usd"])):
                best[symbol] = row
        lines.append("| symbol | best_horizon | trades | hit_rate | PF | net_pnl | actions/day |")
        lines.append("|---|---:|---:|---:|---:|---:|---:|")
        for symbol, row in best.items():
            lines.append(
                f"| {symbol} | {row['horizon']} | {int(row['trades'])} | {float(row['direction_hit_rate']):.2%} | "
                f"{float(row['profit_factor']):.2f} | ${float(row['net_pnl_usd']):.2f} | {float(row['actions_per_day']):.2f} |"
            )
    else:
        lines.append("No blind trades were generated.")
    lines.extend(
        [
            "",
            "## Gate",
            "",
            "V5.19 is research-only. It can advise open/add/reduce/reverse/hold, but it does not replace V5.18 exact-lineage forward shadow until blind and forward evidence are sufficient.",
            "",
        ]
    )
    REPORT_PATH.write_text("\n".join(lines), encoding="utf-8")


def write_figure(predictions: list[dict[str, Any]]) -> None:
    if not predictions:
        return
    df = pd.DataFrame(predictions)
    piv = df.pivot_table(index="symbol", columns="horizon", values="confidence", aggfunc="max")
    order = [label_for_minutes(m) for m in HORIZONS_MIN]
    piv = piv.reindex(columns=[c for c in order if c in piv.columns])
    plt.figure(figsize=(10, 4.5))
    plt.imshow(piv.fillna(0).to_numpy(), aspect="auto", cmap="viridis", vmin=0.5, vmax=1.0)
    plt.colorbar(label="confidence")
    plt.yticks(range(len(piv.index)), piv.index)
    plt.xticks(range(len(piv.columns)), piv.columns, rotation=30)
    plt.title("V5.19 multi-horizon confidence")
    plt.tight_layout()
    plt.savefig(FIGURE_PATH, dpi=160)
    plt.close()


def main() -> None:
    all_predictions: list[dict[str, Any]] = []
    coverage: list[dict[str, Any]] = []
    for symbol in SYMBOLS:
        rows, meta = predict_symbol(symbol)
        all_predictions.extend(rows)
        coverage.append(meta)
    positions = load_v518_positions()
    actions = controller_actions(all_predictions, positions)
    blind_rows, blind_summaries, blind_coverage = run_blind_backtest()
    recommendation = blind_recommendation(blind_summaries)
    pd.DataFrame(all_predictions).to_csv(PREDICTIONS_PATH, index=False)
    pd.DataFrame(actions).to_csv(CONTROLLER_PATH, index=False)
    pd.DataFrame(blind_rows).to_csv(BLIND_PATH, index=False)
    pd.DataFrame(blind_summaries).to_csv(BLIND_SUMMARY_PATH, index=False)
    summary = {
        "version": VERSION,
        "generated_at": utc_now().isoformat(),
        "status": "research_shadow_not_promoted",
        "symbols": len(SYMBOLS),
        "real_market_symbols": sum(1 for row in coverage if row["is_real_market_data"]),
        "prediction_rows": len(all_predictions),
        "controller_action_count": len(actions),
        "non_flat_actions": sum(1 for row in actions if row["controller_action"] not in {"NO_TRADE", "HOLD"}),
        "coverage": coverage,
        "blind_backtest": {
            "enabled": True,
            "rows": len(blind_rows),
            "summary_rows": len(blind_summaries),
            "coverage": blind_coverage,
            "recommendation": recommendation,
        },
        "outputs": {
            "summary_json": str(SUMMARY_PATH),
            "predictions_csv": str(PREDICTIONS_PATH),
            "controller_actions_csv": str(CONTROLLER_PATH),
            "blind_backtest_csv": str(BLIND_PATH),
            "blind_summary_csv": str(BLIND_SUMMARY_PATH),
            "report_md": str(REPORT_PATH),
            "figure_png": str(FIGURE_PATH),
        },
    }
    SUMMARY_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    write_report(summary, actions, blind_summaries)
    write_figure(all_predictions)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
